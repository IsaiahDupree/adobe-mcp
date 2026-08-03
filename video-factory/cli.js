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
const { ElevenLabsManager } = require("./lib/elevenlabs-manager");
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
const { SceneDirector } = require("./lib/scene-director");
const { SubjectAnalyzer } = require("./lib/subject-analyzer");
const { ResponsiveLayoutEngine } = require("./lib/responsive-layout-engine");
const { AnimationGrammarRenderer } = require("./lib/animation-grammar-renderer");
const { CompositionQa } = require("./lib/composition-qa");
const { CompositionBatchRunner, CompositionBatchStore } = require("./lib/composition-batch");
const { ShortFormBatchRunner, ShortFormBatchStore, styleRegistry } = require("./lib/short-form-batch");
const { FramingTracker } = require("./lib/framing-tracker");
const { ReviseRunner } = require("./lib/revise-runner");
const { ReviseStore } = require("./lib/revise-store");
const { JobStore } = require("./lib/store");
const { VideoJobRunner } = require("./lib/workflow");
const { createFactoryServer } = require("./lib/server");
const { ensureDir, run, sleep } = require("./lib/util");

function usage() {
    console.error(`Premiere Video Factory

Usage:
  node cli.js health [--ensure]
  node cli.js voices-sync [--output /absolute/path/voices.json]
  node cli.js open-project </absolute/path/project.prproj>
  node cli.js submit <job.json> [--run]
  node cli.js board-submit <board.json> [--run]
  node cli.js board-run <board-id>
  node cli.js board-status [board-id]
  node cli.js composition-submit <composition.json> [--run]
  node cli.js composition-run <composition-id>
  node cli.js composition-status [composition-id]
  node cli.js shorts-submit <short-form.json> [--run]
  node cli.js shorts-run <short-form-id>
  node cli.js shorts-status [short-form-id]
  node cli.js shorts-styles
  node cli.js framing-status [job-id]
  node cli.js revise-submit <revise.json> [--design] [--run]
  node cli.js revise-design <revise-id>
  node cli.js revise-run <revise-id>
  node cli.js revise-status [revise-id]
  node cli.js revise-templates
  node cli.js revise-metrics <revise-id> <metrics.json>
  node cli.js revise-evaluate <revise-id> [--window 24h]
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
    const archiveManager = new ArchiveManager(config, adapter, cepAdapter);
    const elevenLabsManager = new ElevenLabsManager(config);
    const heygenManager = new HeyGenManager(config, elevenLabsManager);
    const retentionEditor = new RetentionPlanner();
    const showcaseRenderer = new ShowcaseRenderer(config);
    const assetBroker = new ProductionAssetBroker(config);
    const localNarrationManager = new LocalNarrationManager(config);
    const framingTracker = new FramingTracker(config);
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
        assetBroker,
        new SceneDirector(),
        new SubjectAnalyzer(config),
        new ResponsiveLayoutEngine(),
        new AnimationGrammarRenderer(config),
        new CompositionQa(),
        framingTracker
    );
    const boardStore = new BoardStore(config);
    const compositionStore = new CompositionBatchStore(config, store);
    const compositionRunner = new CompositionBatchRunner(compositionStore, store, runner);
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
    const reviseStore = new ReviseStore(config);
    const reviseRunner = new ReviseRunner({
        reviseStore,
        boardStore,
        boardRunner,
        jobStore: store,
    });
    const shortFormStore = new ShortFormBatchStore(config, store, boardStore, compositionStore);
    const shortFormRunner = new ShortFormBatchRunner(shortFormStore, store, runner);
    return {
        adapter,
        heygenManager,
        elevenLabsManager,
        store,
        appManager,
        runner,
        boardStore,
        boardRunner,
        compositionStore,
        compositionRunner,
        shortFormStore,
        shortFormRunner,
        framingTracker,
        reviseStore,
        reviseRunner,
    };
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
    const {
        heygenManager,
        elevenLabsManager,
        store,
        appManager,
        runner,
        boardStore,
        boardRunner,
        compositionStore,
        compositionRunner,
        shortFormStore,
        shortFormRunner,
        framingTracker,
        reviseStore,
        reviseRunner,
    } = createRuntime();

    if (command === "health") {
        print(args.includes("--ensure") ? await appManager.ensureReady() : await appManager.health());
        return;
    }
    if (command === "voices-sync") {
        const output = optionValue(args, "--output", path.join(config.FACTORY_HOME, "voice-registry", "heygen-voices.json"));
        ensureDir(path.dirname(output));
        const voices = [];
        for (const type of ["private", "public"]) {
            let token = null;
            do {
                const response = await heygenManager.listVoices({ type, language: "English", limit: 100, token });
                const data = response.data || [];
                voices.push(...data.map((voice) => ({ ...voice, type })));
                token = response.has_more ? response.next_token : null;
            } while (token);
        }
        const elevenLabsVoices = await elevenLabsManager.listVoices();
        const registry = {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            defaults: {
                voiceProvider: "elevenlabs",
                elevenLabsVoiceId: config.ELEVENLABS_VOICE_ID,
                heygenVoiceId: config.HEYGEN_VOICE_ID,
            },
            requestedCandidates: [{
                provider: "unknown",
                voiceId: "e40f41c567924222a60ed3e1d557fc77",
                validation: "invalid-for-elevenlabs-and-not-present-in-heygen-catalog",
            }],
            heygen: { voices },
            elevenlabs: {
                voices: elevenLabsVoices.map((voice) => ({
                    voice_id: voice.voice_id,
                    name: voice.name,
                    category: voice.category,
                    labels: voice.labels || {},
                })),
            },
        };
        fs.writeFileSync(output, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
        print({
            output,
            heygenVoiceCount: voices.length,
            elevenLabsVoiceCount: elevenLabsVoices.length,
            defaultProvider: registry.defaults.voiceProvider,
            selectedHeyGenVoiceId: config.HEYGEN_VOICE_ID,
            selectedElevenLabsVoiceId: config.ELEVENLABS_VOICE_ID,
        });
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
    if (command === "composition-submit") {
        if (!args[1]) throw new Error("composition-submit requires a composition JSON file.");
        const spec = JSON.parse(fs.readFileSync(path.resolve(args[1]), "utf8"));
        const batch = compositionStore.submit(spec);
        print(args.includes("--run") ? await compositionRunner.run(batch.id) : batch);
        return;
    }
    if (command === "composition-run") {
        if (!args[1]) throw new Error("composition-run requires a composition ID.");
        print(await compositionRunner.run(args[1]));
        return;
    }
    if (command === "composition-status") {
        print(args[1] ? compositionStore.get(args[1]) : { compositions: compositionStore.list() });
        return;
    }
    if (command === "shorts-submit") {
        if (!args[1]) throw new Error("shorts-submit requires a short-form JSON file.");
        const spec = JSON.parse(fs.readFileSync(path.resolve(args[1]), "utf8"));
        const batch = shortFormStore.submit(spec);
        print(args.includes("--run") ? await shortFormRunner.run(batch.id) : batch);
        return;
    }
    if (command === "shorts-run") {
        if (!args[1]) throw new Error("shorts-run requires a short-form ID.");
        print(await shortFormRunner.run(args[1]));
        return;
    }
    if (command === "shorts-status") {
        print(args[1] ? shortFormStore.get(args[1]) : { shortFormBatches: shortFormStore.list() });
        return;
    }
    if (command === "shorts-styles") {
        print(styleRegistry);
        return;
    }
    if (command === "framing-status") {
        print(framingTracker.status(args[1] || null));
        return;
    }
    if (command === "revise-submit") {
        if (!args[1]) throw new Error("revise-submit requires a REVISE JSON file.");
        const spec = JSON.parse(fs.readFileSync(path.resolve(args[1]), "utf8"));
        const state = reviseStore.submit(spec);
        if (args.includes("--run")) print(await reviseRunner.run(state.id));
        else if (args.includes("--design")) print(await reviseRunner.design(state.id));
        else print(state);
        return;
    }
    if (command === "revise-design") {
        if (!args[1]) throw new Error("revise-design requires a REVISE ID.");
        print(await reviseRunner.design(args[1]));
        return;
    }
    if (command === "revise-run") {
        if (!args[1]) throw new Error("revise-run requires a REVISE ID.");
        print(await reviseRunner.run(args[1]));
        return;
    }
    if (command === "revise-status") {
        print(args[1] ? reviseStore.get(args[1]) : { reviseLoops: reviseStore.list() });
        return;
    }
    if (command === "revise-templates") {
        print(reviseStore.templateLibrary());
        return;
    }
    if (command === "revise-metrics") {
        if (!args[1] || !args[2]) throw new Error("revise-metrics requires a REVISE ID and metrics JSON file.");
        const metrics = JSON.parse(fs.readFileSync(path.resolve(args[2]), "utf8"));
        print(reviseStore.recordMetrics(args[1], metrics));
        return;
    }
    if (command === "revise-evaluate") {
        if (!args[1]) throw new Error("revise-evaluate requires a REVISE ID.");
        print(reviseRunner.evaluate(args[1], optionValue(args, "--window", null)));
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
            compositionStore,
            compositionRunner,
            framingTracker,
            reviseStore,
            reviseRunner,
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
