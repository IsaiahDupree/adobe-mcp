# Premiere Project State And Marketing Review

This document defines the software guardrails for running Premiere edit packets when
Premiere can only have one active project at a time, and for having a deterministic
marketing representative judge an edit team's output before any social handoff.

## Project State Rule

Before a live operation packet sends editing commands to Premiere, the runner must
know two things:

- the active Premiere project from `getProjectInfo`
- the requested project from the first selected `createProject` or `openProject`
  operation in the packet

The runner then applies this state machine:

| Mode | Meaning | Action |
| --- | --- | --- |
| `NO_REQUESTED_PROJECT` | The selected operations do not create or open a project. | Run the selected operations without project handoff. |
| `NO_ACTIVE_PROJECT` | Premiere has no active project. | Run the packet's project-opening operation normally. |
| `REQUESTED_PROJECT_ALREADY_ACTIVE` | Premiere already has the requested project open. | Skip that opening operation with `SKIPPED_PROJECT_ALREADY_ACTIVE` and continue. |
| `SAVE_AND_CLOSE_ACTIVE_PROJECT` | Premiere has a different project open. | Send `saveProject`, then `closeProject`, then `getProjectInfo` before running the packet. |

The handoff receipt is written into `run-summary.json` under
`project_handoff`. A failed save, close, or close verification stops the run before
timeline mutation with status `PROJECT_HANDOFF_FAILED`.

## Save Requirement

Any selected packet that includes `createProject` or `openProject` must also include
`saveProject` or `saveProjectAs`. The live runner enforces this in preflight with
the `project_save_planned` check.

This keeps project creation from being treated as temporary UI state. Every created
or opened marketing edit must leave behind a saved `.prproj` artifact that can be
reopened, reviewed, and traced.

## Recovery

When `PROJECT_HANDOFF_FAILED` appears:

1. Open `run-summary.json` and inspect `project_handoff.failedStep`.
2. If `saveProject` failed, do not open a different packet yet. The active project
   may have unsaved work.
3. If `closeProject` failed or verification still shows the previous project active,
   restart the local stack and Premiere before retrying the packet.
4. Retry with the same packet after `getProjectInfo` confirms either no active
   project or the exact requested project.

The runner does not force-close or discard projects. It fails closed because losing
an edit project is worse than delaying a batch.

## Marketing Representative Review

`MarketingDepartmentRepresentative` is a deterministic local reviewer. It judges
the edit team's work from the operation packet or production receipt, the runner
summary, output measurement, and QC frames.

It scores these categories:

- business objective fit
- rights and provenance
- Premiere project discipline
- platform readiness
- retention pacing
- caption or narrative clarity
- audio and sound design
- analytics traceability

Approval requires no critical failures and an overall score of at least `82`.

Critical failures include:

- runner did not complete cleanly
- Premiere project handoff failed
- project was created/opened without a successful save
- `not_published` or provider-write safety was violated
- direct-use footage lacks owned/licensed/direct-use rights

No-caption styles are allowed. They pass the clarity gate when the packet provides
narrative edit evidence such as story markers, structured cuts, silence removal, or
jump-cut rules.

## Review API

The local factory server exposes:

```bash
POST /api/marketing/review-edit
```

Request:

```json
{
  "packet": {},
  "runSummary": {},
  "outputMeasurement": {
    "path": "/absolute/path/to/export.mp4",
    "width": 1080,
    "height": 1920
  },
  "qcFrames": [
    "/absolute/path/to/frame-0.png",
    "/absolute/path/to/frame-5.png",
    "/absolute/path/to/frame-10.png"
  ]
}
```

Response:

```json
{
  "verdict": "APPROVED_FOR_INTERNAL_MARKETING_HANDOFF",
  "overallScore": 100,
  "requiredFixes": [],
  "socialAnalyticsTrace": {
    "edit_plan_id": "...",
    "output_id": "...",
    "style_profile_id": "...",
    "social_action_id": "...",
    "experiment_id": "...",
    "variant_id": "..."
  }
}
```

If the edit needs more work, the route still returns `200` with
`verdict: "NEEDS_EDITING_REVISION"` and a `requiredFixes` list. Malformed requests
return `API_VALIDATION_FAILED`.

## Test Coverage

Focused tests:

```bash
node --test \
  video-factory/tests/premiere-project-handoff.test.js \
  video-factory/tests/marketing-review-judge.test.js \
  video-factory/tests/marketing-review-api.test.js \
  video-factory/tests/server-errors.test.js \
  video-factory/tests/premiere-operation-safety.test.js
```

Covered cases:

- different active project is saved, closed, and verified before switching
- already-active requested project skips duplicate create/open
- handoff fails closed when save fails
- handoff fails closed when close verification still shows the old project
- marketing approves an owned-media, local-only edit with QC evidence
- marketing rejects failed project handoff and missing save
- marketing blocks external YouTube direct use without rights
- no-caption narrative styles can pass with story-edit evidence
- API route returns review verdicts and typed validation failures
