# Premiere Video Factory

This is the durable single-node control plane for agent-driven Premiere production. Agents submit a structured job; the worker schedules it, prepares Premiere and the UXP bridge, creates or versions the project, imports real assets, assembles the sequence, validates the timeline, saves, optionally renders through Adobe Media Encoder, and records every checkpoint.

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
