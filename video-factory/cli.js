#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const config = require("./lib/config");
const { PremiereAdapter } = require("./lib/premiere-adapter");
const { CepAdapter } = require("./lib/cep-adapter");
const { CaptionRenderer } = require("./lib/caption-renderer");
const { ApplicationManager } = require("./lib/app-manager");
const { ArchiveManager } = require("./lib/archive-manager");
const { HeyGenManager } = require("./lib/heygen-manager");
const { RetentionPlanner } = require("./lib/retention-planner");
const { ShowcaseRenderer } = require("./lib/showcase-renderer");
const { ProductionAssetBroker } = require("./lib/asset-broker");
const { BoardStore } = require("./lib/board-store");
const { BriefArchitect } = require("./lib/brief-architect");
const { ProductionBoardRunner } = require("./lib/board-runner");
const { MediaAnalyzer } = require("./lib/media-analyzer");
const { PerformanceMemory } = require("./lib/performance-memory");
const { ReleaseArbiter } = require("./lib/release-arbiter");
const { ReleasePackager } = require("./lib/release-packager");
const { Showrunner } = require("./lib/showrunner");
const { TechnicalQa } = require("./lib/technical-qa");
const { TrendScout } = require("./lib/trend-scout");
const { LocalNarrationManager } = require("./lib/local-narration-manager");
const { JobStore } = require("./lib/store");
const { VideoJobRunner } = require("./lib/workflow");
const { createFactoryServer } = require("./lib/server");
const { ensureDir, run, sleep } = require("./lib/util");

function usage() {
    console.error(`Premiere Video Factory

Usage:
  node cli.js health [--ensure]
  node cli.js open-project </absolute/path/project.prproj>
  node cli.js submit <job.json> [--run]
  node cli.js board-submit <board.json> [--run]
  node cli.js board-run <board-id>
  node cli.js board-status [board-id]
  node cli.js run <job-id>
  node cli.js status [job-id]
  node cli.js tick
  node cli.js approve <job-id>
  node cli.js cancel <job-id>
  node cli.js archive <job-id> [--move] [--include-source-assets]
  node cli.js serve [--port 3032]
  node cli.js install-service
  node cli.js start-service
  node cli.js stop-service`);
}

function print(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function createRuntime() {
    const adapter = new PremiereAdapter(config);
    const cepAdapter = new CepAdapter(config);
    const captionRenderer = new CaptionRenderer(config);
    const store = new JobStore(config);
    const appManager = new ApplicationManager(config, adapter, cepAdapter);
    const archiveManager = new ArchiveManager(config, adapter);
    const heygenManager = new HeyGenManager(config);
    const retentionEditor = new RetentionPlanner();
    const showcaseRenderer = new ShowcaseRenderer(config);
    const assetBroker = new ProductionAssetBroker(config);
    const localNarrationManager = new LocalNarrationManager(config);
    const runner = new VideoJobRunner(
        store,
        appManager,
        adapter,
        archiveManager,
        heygenManager,
        retentionEditor,
        cepAdapter,
        captionRenderer,
        showcaseRenderer,
        localNarrationManager,
        assetBroker
    );
    const boardStore = new BoardStore(config);
    const boardRunner = new ProductionBoardRunner({
        config,
        boardStore,
        jobStore: store,
        jobRunner: runner,
        trendScout: new TrendScout(config),
        performanceMemory: new PerformanceMemory(config),
        briefArchitect: new BriefArchitect(),
        showrunner: new Showrunner(),
        technicalQa: new TechnicalQa(config),
        mediaAnalyzer: new MediaAnalyzer(config),
        releaseArbiter: new ReleaseArbiter(),
        releasePackager: new ReleasePackager(),
    });
    return { adapter, store, appManager, runner, boardStore, boardRunner };
}

function optionValue(args, name, fallback) {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function servicePlist() {
    const logDir = path.join(config.FACTORY_HOME, "logs");
    ensureDir(logDir);
    const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escape(config.FACTORY_LAUNCH_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(process.execPath)}</string>
    <string>${escape(path.join(__dirname, "cli.js"))}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>${escape(__dirname)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(path.join(logDir, "service.log"))}</string>
  <key>StandardErrorPath</key><string>${escape(path.join(logDir, "service.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>VIDEO_FACTORY_HOME</key><string>${escape(config.FACTORY_HOME)}</string>
    <key>VIDEO_FACTORY_PORT</key><string>${config.FACTORY_PORT}</string>
    <key>PROXY_URL</key><string>${escape(config.PROXY_URL)}</string>
    <key>VIDEO_FACTORY_PASSPORT_MOUNT</key><string>${escape(config.PASSPORT_MOUNT)}</string>
    <key>VIDEO_FACTORY_ARCHIVE_ROOT</key><string>${escape(config.PASSPORT_ARCHIVE_ROOT)}</string>
  </dict>
</dict>
</plist>
`;
}

async function serviceCommand(action) {
    const launchAgents = path.join(process.env.HOME, "Library", "LaunchAgents");
    const plistPath = path.join(launchAgents, `${config.FACTORY_LAUNCH_LABEL}.plist`);
    const domain = `gui/${process.getuid()}`;
    if (action === "install") {
        ensureDir(launchAgents);
        fs.writeFileSync(plistPath, servicePlist(), "utf8");
        try {
            await run("/bin/launchctl", [
                "bootout",
                `${domain}/${config.FACTORY_LAUNCH_LABEL}`,
            ]);
        } catch {
            // The service may not be loaded yet.
        }
        let bootstrapError;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                await run("/bin/launchctl", ["bootstrap", domain, plistPath]);
                bootstrapError = null;
                break;
            } catch (error) {
                bootstrapError = error;
                await sleep(500);
            }
        }
        if (bootstrapError) throw bootstrapError;
        await run("/bin/launchctl", [
            "kickstart",
            "-k",
            `${domain}/${config.FACTORY_LAUNCH_LABEL}`,
        ]);
        return { installed: true, plistPath, label: config.FACTORY_LAUNCH_LABEL };
    }
    if (action === "start") {
        await run("/bin/launchctl", [
            "kickstart",
            "-k",
            `${domain}/${config.FACTORY_LAUNCH_LABEL}`,
        ]);
        return { started: true, label: config.FACTORY_LAUNCH_LABEL };
    }
    await run("/bin/launchctl", [
        "kill",
        "SIGTERM",
        `${domain}/${config.FACTORY_LAUNCH_LABEL}`,
    ]);
    return { stopped: true, label: config.FACTORY_LAUNCH_LABEL };
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    if (!command || ["-h", "--help", "help"].includes(command)) {
        usage();
        process.exit(command ? 0 : 2);
    }
    const { store, appManager, runner, boardStore, boardRunner } = createRuntime();

    if (command === "health") {
        print(args.includes("--ensure") ? await appManager.ensureReady() : await appManager.health());
        return;
    }
    if (command === "open-project") {
        if (!args[1]) throw new Error("open-project requires an absolute .prproj path.");
        print(await appManager.openProject(args[1]));
        return;
    }
    if (command === "submit") {
        if (!args[1]) throw new Error("submit requires a job JSON file.");
        const spec = JSON.parse(fs.readFileSync(path.resolve(args[1]), "utf8"));
        const job = store.submit(spec);
        print(args.includes("--run") ? await runner.run(job.id) : job);
        return;
    }
    if (command === "board-submit") {
        if (!args[1]) throw new Error("board-submit requires a board JSON file.");
        const spec = JSON.parse(fs.readFileSync(path.resolve(args[1]), "utf8"));
        const board = boardStore.submit(spec);
        print(args.includes("--run") ? await boardRunner.run(board.id) : board);
        return;
    }
    if (command === "board-run") {
        if (!args[1]) throw new Error("board-run requires a board ID.");
        print(await boardRunner.run(args[1]));
        return;
    }
    if (command === "board-status") {
        print(args[1] ? boardStore.get(args[1]) : { boards: boardStore.list() });
        return;
    }
    if (command === "run") {
        if (!args[1]) throw new Error("run requires a job ID.");
        print(await runner.run(args[1]));
        return;
    }
    if (command === "status") {
        print(args[1] ? store.get(args[1]) : { jobs: store.list() });
        return;
    }
    if (command === "tick") {
        print(await runner.tick());
        return;
    }
    if (command === "approve") {
        print(store.approve(args[1]));
        return;
    }
    if (command === "cancel") {
        print(store.cancel(args[1]));
        return;
    }
    if (command === "archive") {
        if (!args[1]) throw new Error("archive requires a job ID.");
        print(
            await runner.archive(args[1], {
                mode: args.includes("--move") ? "move" : "copy",
                includeSourceAssets: args.includes("--include-source-assets"),
                destinationRoot: optionValue(args, "--destination-root", undefined),
            })
        );
        return;
    }
    if (command === "serve") {
        const port = Number(optionValue(args, "--port", config.FACTORY_PORT));
        const { server, startScheduler } = createFactoryServer({
            store,
            runner,
            appManager,
            config,
            boardStore,
            boardRunner,
        });
        server.listen(port, "127.0.0.1", () => {
            process.stdout.write(`Premiere Video Factory listening on http://127.0.0.1:${port}\n`);
        });
        startScheduler();
        return;
    }
    if (command === "install-service") {
        print(await serviceCommand("install"));
        return;
    }
    if (command === "start-service") {
        print(await serviceCommand("start"));
        return;
    }
    if (command === "stop-service") {
        print(await serviceCommand("stop"));
        return;
    }
    usage();
    process.exitCode = 2;
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
