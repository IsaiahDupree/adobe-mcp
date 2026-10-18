const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { run, sleep } = require("./util");
const {
    appendStartupEvent,
    initStartupJournal,
    writeStartupSummary,
} = require("./startup-journal");

class AppReadinessError extends Error {
    constructor(message, details = {}, code = "APP_NOT_READY") {
        super(message);
        this.name = "AppReadinessError";
        this.code = code;
        this.details = details;
    }
}

function parseLoaderReceipt(error) {
    const output = String(error?.stdout || "").trim();
    if (!output) return null;
    const start = output.indexOf("{");
    if (start < 0) return null;
    try {
        return JSON.parse(output.slice(start));
    } catch {
        return null;
    }
}

function optionValue(args, name, fallback = null) {
    const equalsPrefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(equalsPrefix));
    if (inline) return inline.slice(equalsPrefix.length);
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

class ApplicationManager {
    constructor(config, adapter, cepAdapter = null) {
        this.config = config;
        this.adapter = adapter;
        this.cepAdapter = cepAdapter;
    }

    async proxyStatus() {
        try {
            const response = await fetch(`${this.config.PROXY_URL}/status`, {
                signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) return null;
            return response.json();
        } catch {
            return null;
        }
    }

    async processRunning(pattern) {
        try {
            const { stdout } = await run("/usr/bin/pgrep", ["-f", pattern], { timeout: 5000 });
            return stdout.trim().length > 0;
        } catch {
            return false;
        }
    }

    async diskFreeGb() {
        try {
            const target = fs.existsSync(this.config.FACTORY_HOME)
                ? this.config.FACTORY_HOME
                : path.dirname(this.config.FACTORY_HOME);
            const { stdout } = await run("/bin/df", ["-Pk", target]);
            const line = stdout.trim().split("\n").at(-1).trim().split(/\s+/);
            return Math.round((Number(line[3]) / 1024 / 1024) * 10) / 10;
        } catch {
            return null;
        }
    }

    async toolVersion(command, args = ["--version"]) {
        try {
            const { stdout, stderr } = await run(command, args, { timeout: 5000 });
            return `${stdout}${stderr}`.trim().split("\n")[0];
        } catch {
            return null;
        }
    }

    async health() {
        const [
            proxy,
            premiereRunning,
            mediaEncoderRunning,
            udtRunning,
            diskFreeGb,
            ffprobe,
            imageMagick,
            uxpCli,
        ] = await Promise.all([
            this.proxyStatus(),
            this.processRunning("Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026"),
            this.processRunning("Adobe Media Encoder 2026.app/Contents/MacOS/Adobe Media Encoder 2026"),
            this.processRunning("Adobe UXP Developer Tools.app/Contents/MacOS/Adobe UXP Developer Tools"),
            this.diskFreeGb(),
            this.toolVersion("ffprobe", ["-version"]),
            this.toolVersion(this.config.IMAGEMAGICK_BIN, ["-version"]),
            this.toolVersion(this.config.UXP_CLI),
        ]);

        let responsive = false;
        let project = null;
        let cepConnected = false;
        if (proxy && proxy.clients && proxy.clients.premiere > 0) {
            try {
                const snapshot = await this.adapter.inspectProject();
                responsive = true;
                project = snapshot.project;
            } catch {
                responsive = false;
            }
        }
        if (!responsive && this.cepAdapter) {
            try {
                const probe = await this.cepAdapter.probe();
                responsive = true;
                cepConnected = true;
                project = { hasProject: Boolean(probe.project), name: probe.project };
            } catch {
                cepConnected = false;
            }
        }

        const bridgeConnected = Boolean(
            proxy && proxy.clients && Number(proxy.clients.premiere || 0) > 0
        );
        return {
            node: os.hostname(),
            status:
                premiereRunning && (bridgeConnected || cepConnected) && responsive
                    ? "healthy"
                    : "degraded",
            premiere: {
                installed: fs.existsSync(this.config.PREMIERE_APP_PATH),
                running: premiereRunning,
                responsive,
                project,
            },
            mediaEncoder: {
                installed: fs.existsSync(this.config.MEDIA_ENCODER_APP_PATH),
                running: mediaEncoderRunning,
            },
            proxy: {
                running: Boolean(proxy),
                url: this.config.PROXY_URL,
                details: proxy,
            },
            uxp: {
                developerToolsRunning: udtRunning,
                cliVersion: uxpCli,
                pluginInstalled: fs.existsSync(
                    path.join(this.config.INSTALLED_PLUGIN_DIR, "manifest.json")
                ),
                bridgeConnected,
                cepConnected,
            },
            tools: { ffprobe, imageMagick },
            diskFreeGb,
        };
    }

    async waitFor(check, description, timeoutMs = this.config.APP_READY_TIMEOUT_MS) {
        const started = Date.now();
        let lastError;
        while (Date.now() - started < timeoutMs) {
            try {
                const value = await check();
                if (value) return value;
            } catch (error) {
                lastError = error;
            }
            await sleep(1500);
        }
        throw new AppReadinessError(`Timed out waiting for ${description}.`, {
            lastError: lastError ? lastError.message : null,
        });
    }

    async ensureProxy() {
        if (await this.proxyStatus()) return;
        const domain = `gui/${process.getuid()}`;
        try {
            await run("/bin/launchctl", [
                "kickstart",
                "-k",
                `${domain}/${this.config.PROXY_LAUNCH_LABEL}`,
            ]);
        } catch {
            const child = spawn(
                process.execPath,
                [path.join(this.config.REPO_ROOT, "proxy-server", "proxy.js")],
                { detached: true, stdio: "ignore", env: { ...process.env, PORT: "3031" } }
            );
            child.unref();
        }
        await this.waitFor(() => this.proxyStatus(), "Premiere command proxy", 30000);
    }

    async ensurePremiere() {
        if (!fs.existsSync(this.config.PREMIERE_APP_PATH)) {
            throw new AppReadinessError(`Premiere is not installed at ${this.config.PREMIERE_APP_PATH}.`);
        }
        const running = await this.processRunning(
            "Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026"
        );
        if (!running) {
            await run("/usr/bin/open", ["-a", this.config.PREMIERE_APP_NAME]);
        }
        await this.waitFor(
            () =>
                this.processRunning(
                    "Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026"
                ),
            "Premiere process"
        );
    }

    async ensureMediaEncoder() {
        if (!fs.existsSync(this.config.MEDIA_ENCODER_APP_PATH)) {
            throw new AppReadinessError(
                `Adobe Media Encoder is not installed at ${this.config.MEDIA_ENCODER_APP_PATH}.`
            );
        }
        const pattern =
            "Adobe Media Encoder 2026.app/Contents/MacOS/Adobe Media Encoder 2026";
        if (!(await this.processRunning(pattern))) {
            await run("/usr/bin/open", ["-a", this.config.MEDIA_ENCODER_APP_NAME]);
        }
        await this.waitFor(
            () => this.processRunning(pattern),
            "Adobe Media Encoder process",
            60000
        );
    }

    async ensureUxpService() {
        try {
            await run(this.config.UXP_CLI, ["apps", "list"], { timeout: 10000 });
            return;
        } catch {
            if (!fs.existsSync(this.config.UDT_APP_PATH)) {
                throw new AppReadinessError("Adobe UXP Developer Tools is not installed.");
            }
            await run("/usr/bin/open", ["-a", this.config.UDT_APP_NAME]);
            await this.waitFor(async () => {
                try {
                    await run(this.config.UXP_CLI, ["apps", "list"], { timeout: 10000 });
                    return true;
                } catch {
                    return false;
                }
            }, "UXP Developer Tools service", 60000);
        }
    }

    startupLoaderArgs(journal = null) {
        const runDir = journal?.logs?.runDir || null;
        return [
            ...(runDir ? ["--evidence-dir", path.join(runDir, "uxp-loader")] : []),
            "--host-timeout-ms",
            String(process.env.PREMIERE_UXP_HOST_TIMEOUT_MS || 30000),
            "--timeout-ms",
            String(process.env.PREMIERE_UXP_LOAD_TIMEOUT_MS || 15000),
            "--retry-delay-ms",
            String(process.env.PREMIERE_UXP_RETRY_DELAY_MS || 1000),
            "--retries",
            String(process.env.PREMIERE_UXP_RETRIES || 1),
        ];
    }

    loaderCommandTimeoutMs(loaderArgs) {
        const hostTimeoutMs = Number(optionValue(loaderArgs, "--host-timeout-ms", 30000));
        const attemptTimeoutMs = Number(optionValue(loaderArgs, "--timeout-ms", 15000));
        const retryDelayMs = Number(optionValue(loaderArgs, "--retry-delay-ms", 1000));
        const retries = Number(optionValue(loaderArgs, "--retries", 1));
        const budgetMs =
            hostTimeoutMs +
            (Math.max(0, retries) + 1) * attemptTimeoutMs +
            Math.max(0, retries) * retryDelayMs +
            10000;
        return Number(process.env.PREMIERE_UXP_LOADER_COMMAND_TIMEOUT_MS || Math.max(30000, budgetMs));
    }

    createStartupJournal(loaderArgs) {
        return initStartupJournal({
            root: this.config.FACTORY_PACKAGE_DIR,
            adobeMcpRoot: this.config.REPO_ROOT,
            factoryHome: this.config.FACTORY_HOME,
            logDir: path.join(this.config.FACTORY_HOME, "logs"),
            proxyUrl: this.config.PROXY_URL,
            factoryUrl: `http://127.0.0.1:${this.config.FACTORY_PORT}`,
            factoryReadyUrl: `http://127.0.0.1:${this.config.FACTORY_PORT}/api/errors`,
            loaderArgs,
            premiereAppName: this.config.PREMIERE_APP_NAME,
            premiereAppPath: this.config.PREMIERE_APP_PATH,
            mediaEncoderAppName: this.config.MEDIA_ENCODER_APP_NAME,
            mediaEncoderAppPath: this.config.MEDIA_ENCODER_APP_PATH,
            udtAppName: this.config.UDT_APP_NAME,
            udtAppPath: this.config.UDT_APP_PATH,
            uxpCli: this.config.UXP_CLI,
            pluginDir: this.config.INSTALLED_PLUGIN_DIR,
        });
    }

    async startupPhase(journal, phase, message, action) {
        if (!journal) return action();
        appendStartupEvent({
            runDir: journal.logs.runDir,
            phase,
            status: "started",
            message,
        });
        const started = Date.now();
        try {
            const result = await action();
            appendStartupEvent({
                runDir: journal.logs.runDir,
                phase,
                status: "complete",
                message,
                durationMs: Date.now() - started,
            });
            return result;
        } catch (error) {
            appendStartupEvent({
                runDir: journal.logs.runDir,
                phase,
                status: "failed",
                message,
                durationMs: Date.now() - started,
                details: {
                    code: error.code || error.name,
                    message: error.message,
                },
            });
            throw error;
        }
    }

    startupJournalDetails(journal) {
        if (!journal) return undefined;
        return {
            runDir: journal.logs.runDir,
            startupConfig: journal.logs.startupConfig,
            startupRunLog: journal.logs.startupRunLog,
            startupSummary: journal.logs.startupSummary,
            loaderEvidenceDir: journal.logs.loaderEvidenceDir,
        };
    }

    async ensureBridge(journal = null) {
        const proxy = await this.proxyStatus();
        if (proxy && proxy.clients && proxy.clients.premiere > 0) return;
        if (this.cepAdapter) {
            try {
                await this.cepAdapter.probe();
                return;
            } catch {
                // Continue to the UXP UI load path while the CEP panel starts.
            }
        }
        await this.ensureUxpService();
        if (!fs.existsSync(path.join(this.config.INSTALLED_PLUGIN_DIR, "manifest.json"))) {
            throw new AppReadinessError(
                `Premiere UXP plugin is not installed at ${this.config.INSTALLED_PLUGIN_DIR}.`
            );
        }
        const loaderArgs = this.startupLoaderArgs(journal);
        try {
            await run(process.execPath, [
                path.join(this.config.FACTORY_PACKAGE_DIR, "scripts/uxp-load-premiere-plugin.js"),
                ...loaderArgs,
            ], {
                cwd: this.config.FACTORY_PACKAGE_DIR,
                timeout: this.loaderCommandTimeoutMs(loaderArgs),
            });
        } catch (error) {
            const receipt = parseLoaderReceipt(error);
            const terminal = receipt?.terminalError;
            throw new AppReadinessError(
                terminal?.message || `Could not load the Premiere UXP plugin through UXP Developer Tools: ${error.message}`,
                {
                    receiptPath: receipt?.receiptPath,
                    evidenceDir: receipt?.evidenceDir,
                    runLog: receipt?.logs?.run,
                    attempts: receipt?.attempts,
                    recovery: receipt?.recovery,
                    loaderStatus: receipt?.status,
                    stderr: error.stderr || undefined,
                },
                terminal?.code || "UXP_PLUGIN_LOAD_NOT_CONFIRMED"
            );
        }
        await this.waitFor(async () => {
            const status = await this.proxyStatus();
            if (status && status.clients && status.clients.premiere > 0) return true;
            if (!this.cepAdapter) return false;
            try {
                await this.cepAdapter.probe();
                return true;
            } catch {
                return false;
            }
        }, "Premiere automation bridge", 60000);
    }

    async ensureReady(options = {}) {
        const firstLoaderArgs = this.startupLoaderArgs();
        const journal = options.startupJournal === false
            ? null
            : this.createStartupJournal(firstLoaderArgs);
        try {
            const diskFreeGb = await this.startupPhase(
                journal,
                "disk.free",
                "Check factory disk headroom.",
                () => this.diskFreeGb()
            );
            if (diskFreeGb !== null && diskFreeGb < this.config.MIN_DISK_FREE_GB) {
                throw new AppReadinessError(
                    `Only ${diskFreeGb} GB is free; ${this.config.MIN_DISK_FREE_GB} GB is required.`
                );
            }
            await this.startupPhase(
                journal,
                "proxy.ensure",
                "Start or verify the local Premiere command proxy.",
                () => this.ensureProxy()
            );
            await this.startupPhase(
                journal,
                "premiere.ensure",
                "Start or verify Adobe Premiere Pro.",
                () => this.ensurePremiere()
            );
            await this.startupPhase(
                journal,
                "bridge.ensure",
                "Start or verify the Premiere automation bridge.",
                () => this.ensureBridge(journal)
            );
            await this.startupPhase(
                journal,
                "bridge.responsive",
                "Verify the Premiere bridge can answer an inspection probe.",
                () => this.waitFor(async () => {
                    try {
                        if (await this.adapter.isConnected()) await this.adapter.inspectProject();
                        else if (this.cepAdapter) await this.cepAdapter.probe();
                        else return false;
                        return true;
                    } catch {
                        return false;
                    }
                }, "responsive Premiere bridge", 30000)
            );
            if (options.requireMediaEncoder) {
                await this.startupPhase(
                    journal,
                    "media-encoder.ensure",
                    "Start or verify Adobe Media Encoder.",
                    () => this.ensureMediaEncoder()
                );
            }
            const health = await this.startupPhase(
                journal,
                "factory.health",
                "Record final Video Factory health.",
                () => this.health()
            );
            if (journal) {
                writeStartupSummary({
                    runDir: journal.logs.runDir,
                    status: "complete",
                    details: {
                        healthStatus: health.status,
                    },
                });
                health.startupJournal = this.startupJournalDetails(journal);
            }
            return health;
        } catch (error) {
            if (journal) {
                writeStartupSummary({
                    runDir: journal.logs.runDir,
                    status: "failed",
                    details: {
                        code: error.code || error.name,
                        message: error.message,
                    },
                });
                error.details = {
                    ...(error.details || {}),
                    startupJournal: this.startupJournalDetails(journal),
                };
            }
            throw error;
        }
    }

    async openProject(filePath) {
        const requested = typeof filePath === "string" ? filePath : "";
        const resolved = path.resolve(requested);
        if (!path.isAbsolute(requested) || path.extname(resolved).toLowerCase() !== ".prproj") {
            throw new AppReadinessError("openProject requires an absolute .prproj path.");
        }
        if (!fs.existsSync(resolved)) {
            throw new AppReadinessError(`Premiere project not found: ${resolved}`);
        }
        await this.ensureReady();
        let bridge;
        let result;
        if (await this.adapter.isConnected()) {
            result = await this.adapter.command("openProject", { filePath: resolved }, 120000);
            bridge = "uxp";
        } else if (this.cepAdapter) {
            result = await this.cepAdapter.openProject(resolved);
            bridge = "cep";
        } else {
            throw new AppReadinessError("No Premiere automation bridge is available.");
        }
        const health = await this.waitFor(async () => {
            const snapshot = await this.health();
            return snapshot.premiere.responsive && snapshot.premiere.project?.name === path.basename(resolved)
                ? snapshot
                : null;
        }, `Premiere project ${path.basename(resolved)}`, 45000);
        return { success: true, bridge, projectPath: resolved, result, health };
    }
}

module.exports = { ApplicationManager, AppReadinessError };
