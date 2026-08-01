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

## HeyGen retention pipeline

Submit `examples/heygen-retention-job.json` to run the complete presenter workflow. The factory generates each script beat independently through HeyGen v3, downloads the clean MP4 and SRT, and records a resumable generation manifest. It renders transparent caption assets from the timed SRT cues, then Premiere creates the semantic cuts, places those captions on V2, applies Motion Scale reframes, and exports the finished sequence.

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
    "hook_text": "STOP THE SCROLL",
    "pattern_interrupt_text": "THE FIX",
    "punch_in_scale": 1.08
  }
}
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

The API binds to `127.0.0.1` only. It is intentionally not exposed to the public internet.

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
