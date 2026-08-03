# Premiere Video Factory

This is the durable single-node control plane for agent-driven Premiere production. Agents submit a structured job; the worker schedules it, prepares Premiere and its automation bridges, creates or versions the project, imports real assets, assembles the sequence, validates the timeline, saves, optionally renders through Adobe, and records every checkpoint.

## Quick start

```bash
cd /Users/isaiahdupree/Documents/Software/ppro-uxp-load/adobe-mcp/video-factory
node cli.js health --ensure
node cli.js submit examples/rough-cut-job.json --run
node cli.js install-service
curl http://127.0.0.1:3032/api/health
```

Submit jobs over HTTP:

```bash
curl -X POST http://127.0.0.1:3032/api/jobs \
  -H 'Content-Type: application/json' \
  --data-binary @examples/rough-cut-job.json
```

The scheduler runs due jobs in priority order. A job with `schedule.production_start` in the future remains `SCHEDULED` until its production time. Job state lives under `/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory` by default and survives service or app restarts.

## Production input

Use absolute paths for source media, sequence presets, existing projects, export presets, and render output files. A basic media job looks like:

```json
{
  "campaign_id": "campaign-name",
  "request": { "topic": "Video title" },
  "production": {
    "sequence_name": "MASTER",
    "source_assets": [
      "/absolute/path/a-roll.mp4",
      "/absolute/path/b-roll.mp4"
    ],
    "render": {
      "preset_file": "/absolute/path/to/preset.epr",
      "output_file": "/absolute/path/to/master.mp4"
    }
  }
}
```

Jobs use immutable `v001` Premiere project output. When `existing_project_path` is supplied, the worker opens it and immediately saves the active work into the job workspace before editing.

## Short-form vertical editions

Compile one finished Premiere project, a set of finished jobs, a production board's winning jobs, or a composition batch into independent 9:16 edits. The compiler scores semantic scene ranges, trims and rebases the source captions, applies a safe-fill Motion transform, creates a native Premiere caption track, and remasks horizontal caption pixels when the source receipt proves captions were already embedded. It exports through Adobe and rejects incorrect duration, exposed canvas, persistent bars, clipped audio, or non-vertical output.

```bash
node cli.js shorts-styles
node cli.js shorts-submit examples/premiere-master-to-shorts.json
node cli.js shorts-run premiere-agent-factory-v2-shorts-v3
node cli.js shorts-status premiere-agent-factory-v2-shorts-v3
```

Use `variant_mode: "rotate"` to spread selected moments across distinct editing styles, or `variant_mode: "all-styles"` to render controlled style experiments from the same moment. `kinetic-proof` emphasizes proof beats and stronger punch-ins, `clean-authority` uses restrained motion and longer holds, and `rapid-explainer` favors tighter visual-change intervals. Every child preserves source job, project, render, range, caption, style, and archive lineage in its job receipt. Children are held until `shorts-run` is called and remain approval-gated after export.

## HeyGen retention pipeline

Submit `examples/heygen-retention-job.json` to run the complete presenter workflow. The factory generates each script beat independently through HeyGen v3, downloads the clean MP4 and SRT, and records a resumable generation manifest. Premiere creates the semantic cuts, applies Motion reframes, builds a native editable caption track, and exports the finished sequence. Animated caption graphics remain available through `caption_mode: "animated"` or `"both"`.

```bash
node cli.js submit examples/heygen-retention-job.json --run
```

The API key is read from `HEYGEN_API_KEY` or `~/.env`; it is never written into the job. Generated files are stored under `generated-assets/heygen`, while `edit-plans/retention-edit-manifest.json` records every scene, caption cue, and planned visual change. Completed scenes are reused when a later stage is retried. FFmpeg is not used for editing; `ffprobe` is only used to validate downloaded and exported media streams.

Premiere operations prefer the UXP plugin when it is connected. The installed headless CEP bridge is a complete fallback for opening or creating projects, importing assets, creating sequences, placing retention graphics, saving, inspection, and Adobe H.264 export. A stale UXP host therefore does not block queued production.

The relevant input shape is:

```json
{
  "generation": {
    "provider": "heygen",
    "engine": "avatar_iv",
    "aspect_ratio": "9:16",
    "scenes": [
      { "id": "hook", "script": "A short hook." },
      { "id": "payoff", "script": "A concise payoff." }
    ]
  },
  "retention": {
    "preset": "social-dynamic",
    "caption_mode": "native",
    "hook_text": "STOP THE SCROLL",
    "pattern_interrupt_text": "THE FIX",
    "punch_in_scale": 1.08
  }
}
```

See [docs/retention-engine.md](docs/retention-engine.md) for the researched capability map, compiler tiers, native-caption architecture, and preset strategy.

## Scene Composition Engine

The composition runner creates independent HeyGen and Premiere masters for landscape and portrait delivery. It does not crop one output into the other. The checked-in look registry contains all 20 looks retrieved from avatar group `fe1d6bdab82a4e1e955ba4329d467c5b`; visual review selected `93a72551393b4a13a7e256a3fa3ca421` for 16:9 and `3583ef262c2c4b779989de0a79ec14dd` for 9:16.

```bash
node cli.js composition-submit examples/heygen-scene-composition.json --run
node cli.js composition-status heygen-scene-composition-live-20260801
node cli.js framing-status
node cli.js framing-status heygen-scene-composition-live-20260801-16x9
```

Before generation, the Scene Director translates script semantics into an explicit visual-scene plan. After HeyGen returns the real presenter clip, OpenCV samples face position and confidence, ranks free regions, and creates a format-specific responsive layout. Low-confidence or already-tight shots disable camera motion. Safe-fill camera math increases scale whenever a pan would otherwise reveal the canvas, then clamps translation to the remaining covered area. ImageMagick renders panel assets, Premiere applies timed Motion and Opacity keyframes, and native captions remain editable inside the project.

Each child job records `visual-scene-plan.json`, `subject-track.json`, `responsive-layout.json`, `composition-assets.json`, `composition-qa.json`, `heygen-source-framing.json`, and `final-framing-audit.json`. Critical face overlap, caption-safe-zone overlap, missing assets, overlong treatments, unsafe camera coverage, or camera motion below the confidence threshold stops the workflow before Premiere compilation. A post-export crop audit rejects persistent bars that were introduced during editing.

The framing tracker keeps one fleet event per job under `factory/framing/events`. Events identify the HeyGen video, avatar, voice, engine, format, experiment and variant, camera plans, source-frame coverage, final-frame coverage, retry count, and pass/fail result. `factory/framing/summary.json` provides an aggregate view for agents choosing the next framing variant.

## Long-form benchmark

`benchmarks/youtube-retention-showcase.json` produces a 5-8 minute, 16:9 reference video covering the major retention-editing families. It compiles eleven narrated chapters, native captions, timed motion, generated chapter graphics and callouts, provider-sourced B-roll, SFX, Premiere structural QC, Adobe H.264 export, and verified My Passport archival.

The benchmark uses the offline `macos_say` generation provider so it remains runnable when a hosted avatar or TTS account has no credits. Switch `generation.provider` to `heygen` when API credits are available and presenter footage is preferred.

```bash
node cli.js submit benchmarks/youtube-retention-showcase.json --run
```

## Agent API

- `POST /api/jobs` submit a job
- `GET /api/jobs` list jobs
- `GET /api/jobs/:id` inspect status, checkpoints, outputs, and errors
- `POST /api/jobs/:id/run` run or resume now
- `POST /api/jobs/:id/approve` complete an approval-gated job
- `POST /api/jobs/:id/cancel` cancel a job
- `GET /api/health` inspect node, apps, bridge, and queue
- `POST /api/node/ensure` start/reconnect managed applications
- `POST /api/worker/tick` execute the next due job
- `POST /api/compositions` create independent format masters
- `GET /api/compositions` list composition batches
- `GET /api/compositions/:id` inspect both format jobs and selected looks
- `POST /api/compositions/:id/run` run or resume both masters sequentially
- `GET /api/framing` inspect fleet-wide HeyGen framing outcomes
- `GET /api/framing/:job-id` inspect one generation's framing history

The API binds to `127.0.0.1` only. It is intentionally not exposed to the public internet.

## Closed-loop production boards

A production board coordinates research, performance memory, a strict content brief, immutable Premiere revisions, deterministic technical QA, two independent editorial judges, and a release arbiter. The code owns the three-turn limit and hard release gates; every creative recommendation is structured and timecoded.

The no-key execution path uses installed capabilities: `yt-dlp` for public trend evidence, Premiere and CEP for editing, Pexels/Pixabay for provider-only footage, `ffprobe` plus read-only FFmpeg analysis filters for QA, ImageMagick contact sheets, and deterministic local judges. `codex_cli` is also available as a read-only multimodal judge provider using the machine's existing ChatGPT authentication. No OpenAI API key is required for either path. Codex CLI judging has a bounded timeout and falls back to the deterministic judge so a signed-out or stalled session cannot block the queue.

```bash
node cli.js board-submit examples/production-board-local.json --run
node cli.js board-status premiere-production-board-local-20260801-clean
```

Board deliverables include `final.mp4`, a self-contained and location-rebased `final.prproj`, native captions, generated media, provider footage, animated-caption assets, the content brief, trend evidence, timeline events, technical QA, judge scorecards, revision history, release decision, and the asset/license manifest. Local and My Passport copies receive independent checksum manifests after their project media paths are rebased. The strongest playable revision wins; V3 is not automatically preferred. If no revision reaches the configured threshold, the board packages the strongest version as `needs_review` and stops.

Board API:

- `POST /api/boards` submit a board
- `GET /api/boards` list boards
- `GET /api/boards/:id` inspect artifacts, revisions, and release status
- `POST /api/boards/:id/run` run or resume the complete board
- `POST /api/premiere/open-project` with `{ "project_path": "/absolute/path/project.prproj" }` starts the required apps and opens a packaged project through UXP or CEP

## Nested REVISE loops

The REVISE control plane wraps production boards in a durable outer experiment loop. Each variant uses the existing blind, three-turn board as its inner creative loop. V2 and V3 copy V1's verified generation assets instead of spending another HeyGen generation when the script is unchanged.

```bash
node cli.js revise-submit examples/revise-controlled-heygen-hook.json --design
node cli.js revise-run heygen-result-first-hook-20260802
node cli.js revise-metrics <revise-id> /absolute/path/real-metric-snapshots.json
node cli.js revise-evaluate <revise-id> --window 24h
node cli.js revise-status <revise-id>
node cli.js revise-templates
```

Every loop writes `research_packet.json`, `experiment_spec.json`, `variant_manifest.json`, `review_bundle.json`, `publication_plan.json`, and `learning_record.json`. Controlled requests are rejected when more than the primary variable changes. After production, asymmetrical non-primary revision directives mark the experiment contaminated and produce no schedule slots. Publication planning is side-effect free: it applies family, platform, near-duplicate, and exact-export cooldowns, but a separate publisher must consume the approved plan.

Metric snapshots require a real platform post ID and one of `1h`, `2h`, `24h`, `72h`, `7d`, `28d`, or `30d`. The evaluator only compares a window shared by every variant and returns `Ship`, `Replicate`, `Segment`, `Hold`, or `Reject`. Template promotion requires sufficient exposure, practical primary-metric improvement, passing guardrails, uncontaminated lineage, and replication across the configured number of content families.

REVISE API:

- `POST /api/revise` submit a loop
- `GET /api/revise` list loops
- `GET /api/revise/:id` inspect state and lineage
- `GET /api/revise/templates` inspect validated production rules
- `POST /api/revise/:id/design` write the research and experiment gates
- `POST /api/revise/:id/run` run all inner production boards
- `POST /api/revise/:id/metrics` record real metric snapshots
- `POST /api/revise/:id/evaluate` create the learning decision

## My Passport archival

Finished jobs can be copied or moved into `/Volumes/My Passport/VideoFactory/<campaign>/<job>/`. Every file is copied to a temporary destination, verified by byte size and SHA-256, and recorded in `archive-manifest.json` before move mode removes any local payload.

Archive an existing completed job:

```bash
node cli.js archive <job-id>
node cli.js archive <job-id> --move
```

Enable automatic archival in a job request:

```json
{
  "archive": {
    "enabled": true,
    "mode": "move",
    "destination_root": "/Volumes/My Passport/VideoFactory",
    "include_source_assets": false
  }
}
```

Move mode removes completed projects, renders, generated assets, voice assets, proxies, and approved/published payloads after verification. It retains the small local request, QC, receipt, and event records. Original source footage is only included and removed when `include_source_assets` is explicitly enabled.

The matching HTTP operation is `POST /api/jobs/:id/archive` with a body such as `{"mode":"move"}`.
