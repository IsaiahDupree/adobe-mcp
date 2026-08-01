const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { run, sleep } = require("./util");

class AppReadinessError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "AppReadinessError";
        this.code = "APP_NOT_READY";
        this.details = details;
    }
}

class ApplicationManager {
    constructor(config, adapter) {
        this.config = config;
        this.adapter = adapter;
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
            ffmpeg,
            ffprobe,
            uxpCli,
        ] = await Promise.all([
            this.proxyStatus(),
            this.processRunning("Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026"),
            this.processRunning("Adobe Media Encoder 2026.app/Contents/MacOS/Adobe Media Encoder 2026"),
            this.processRunning("Adobe UXP Developer Tools.app/Contents/MacOS/Adobe UXP Developer Tools"),
            this.diskFreeGb(),
            this.toolVersion("ffmpeg", ["-version"]),
            this.toolVersion("ffprobe", ["-version"]),
            this.toolVersion(this.config.UXP_CLI),
        ]);

        let responsive = false;
        let project = null;
        if (proxy && proxy.clients && proxy.clients.premiere > 0) {
            try {
                const snapshot = await this.adapter.inspectProject();
                responsive = true;
                project = snapshot.project;
            } catch {
                responsive = false;
            }
        }

        const bridgeConnected = Boolean(
            proxy && proxy.clients && Number(proxy.clients.premiere || 0) > 0
        );
        return {
            node: os.hostname(),
            status:
                premiereRunning && bridgeConnected && responsive ? "healthy" : "degraded",
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
            },
            tools: { ffmpeg, ffprobe },
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

    async ensureBridge() {
        const proxy = await this.proxyStatus();
        if (proxy && proxy.clients && proxy.clients.premiere > 0) return;
        await this.ensureUxpService();
        if (!fs.existsSync(path.join(this.config.INSTALLED_PLUGIN_DIR, "manifest.json"))) {
            throw new AppReadinessError(
                `Premiere UXP plugin is not installed at ${this.config.INSTALLED_PLUGIN_DIR}.`
            );
        }
        try {
            await run(this.config.UXP_CLI, ["plugin", "reload", "--apps", "premierepro"], {
                cwd: this.config.INSTALLED_PLUGIN_DIR,
                timeout: 30000,
            });
        } catch (error) {
            throw new AppReadinessError(`Could not reload the Premiere UXP plugin: ${error.message}`);
        }
        await this.waitFor(async () => {
            const status = await this.proxyStatus();
            return Boolean(status && status.clients && status.clients.premiere > 0);
        }, "Premiere UXP bridge", 60000);
    }

    async ensureReady(options = {}) {
        const diskFreeGb = await this.diskFreeGb();
        if (diskFreeGb !== null && diskFreeGb < this.config.MIN_DISK_FREE_GB) {
            throw new AppReadinessError(
                `Only ${diskFreeGb} GB is free; ${this.config.MIN_DISK_FREE_GB} GB is required.`
            );
        }
        await this.ensureProxy();
        await this.ensurePremiere();
        await this.ensureBridge();
        await this.waitFor(async () => {
            try {
                await this.adapter.inspectProject();
                return true;
            } catch {
                return false;
            }
        }, "responsive Premiere bridge", 30000);
        if (options.requireMediaEncoder) {
            await this.ensureMediaEncoder();
        }
        return this.health();
    }
}

module.exports = { ApplicationManager, AppReadinessError };
