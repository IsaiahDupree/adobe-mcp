# Premiere Retention Engine

## Editorial model

The engine treats retention editing as a sequence of purposeful attention resets. Every event records its trigger, retention goal, Premiere compiler, timing, parameters, and expected timeline result. Decorative effects are capped by preset so the edit does not become visual noise.

The complete machine-readable inventory is in `config/retention-capabilities.json`. Its `activeCompilers` list distinguishes the production paths already wired into the factory from the documented compiler targets that remain on the roadmap. The active motion compiler writes baseline, ramp-in, hold, ramp-out, and reset keyframes to Premiere's Motion Scale parameter.

| System | Techniques | Premiere construction |
| --- | --- | --- |
| Story | result-first hook, cold open, open loop, rehook, proof before explanation | semantic source-range assembly plus text or graphic events |
| Pacing | pause removal, filler removal, jump cuts, J/L cuts, montage acceleration | transcript-selected source ranges, ripple removal, independent A/V timing |
| Motion | micro punch, slow push, crash zoom, pan and scan | Motion scale and position keyframes with interpolation |
| Proof | B-roll, screenshots, product closeups, comments, statistics | upper-track inserts with transforms and optional MOGRT callouts |
| Layout | picture-in-picture, split screen, before/after | crop, scale, position, opacity, and track layering |
| Transitions | hard cut, dissolve, shape dissolve, zoom blur, light leak | adjacent edits or installed native transitions |
| Captions | phrase captions, single-word captions, animated keywords | native SRT caption track and optional animated MOGRT layer |
| Sound | music bed, ducking, impacts, whooshes, risers, music drop | audio inserts and calculated volume keyframes |
| Finish | Lumetri look, vignette, object focus, CTA end screen | effect presets, masks, MOGRTs, and export presets |

## Compiler tiers

- `native`: documented Premiere timeline, component, transition, keyframe, or caption operations.
- `hybrid`: analysis occurs outside Premiere, but the resulting edit remains editable in the project.
- `preset`: requires a validated local effect preset, transition, LUT, sound, or MOGRT.
- `research`: useful technique that still needs a reliable compiler and readback test.

Adobe's UXP `SequenceEditor` supports clip insertion, overwrite, removal, cloning, and MOGRT insertion. `ComponentParam` supports time-varying values, keyframe creation, and interpolation. Those operations cover the core structural and motion recipes without rendering intermediate video.

## Native captions

Native captions are the default. The factory compiles the combined timed transcript into a project-local SRT, imports it without user interaction, and invokes Premiere's supported `sequence.createCaptionTrack()` operation through the headless CEP bridge. Structural QC fails if a native track was requested but is absent.

Caption modes:

- `native`: editable Premiere caption track only; recommended default.
- `animated`: transparent retention graphics on a video track.
- `both`: native accessibility track plus animated retention graphics.

Premiere 26.3 can create single-word captions in the UI. The automation equivalent is to produce one timed SRT cue per aligned word and compile it through the same native-caption path.

## Presets

- `social-dynamic`: 2.5-second target visual-change cadence, hard cuts, 108% micro punch-ins, native captions.
- `social-accessible`: 3.5-second cadence, slower 105% motion, restrained transitions, native captions.
- `youtube-explainer`: 5-second cadence, 106% emphasis motion, occasional dissolves, native captions.

## Benchmark production

The reusable `benchmarks/youtube-retention-showcase.json` job targets 5-8 minutes and fails QC outside that range. Its eleven chapters cover hooks, pacing, motion, proof, layouts, captions, transitions, graphics, sound/color, and workflow. The compiler places generated graphics on V3, fitted owner-supplied B-roll on V2, native captions on C1, narration on A1, and transition SFX on upper audio tracks.

Long-form narration can use `generation.provider: "macos_say"` for a credential-free offline run. The provider creates real AIFF narration, 16:9 source graphics, and sentence-timed SRT cues; Premiere remains responsible for assembly, motion, overlays, captions, audio placement, project save, and H.264 export.

## Reliability rules

1. Compile structured events, not arbitrary command strings.
2. Read the project and timeline back after every structural phase.
3. Verify clip counts, durations, frame size, caption-track count, and imported assets.
4. Keep source media and generated caption sources in the project workspace.
5. Rebuild a sequence from approved source ranges when destructive trim operations cannot be verified.
6. Record each event's retention goal so published analytics can score recipes later.

## Adobe references

- [SequenceEditor](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequenceeditor)
- [ComponentParam keyframes](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/componentparam)
- [CaptionTrack](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/captiontrack)
- [Adobe CEP sample: SRT to caption track](https://github.com/Adobe-CEP/Samples/blob/master/PProPanel/jsx/PPRO/Premiere.jsx)
- [Create single-word captions](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/create-single-word-captions.html)
- [Detect and delete pauses](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/detect-and-delete-pauses-in-transcripts.html)
- [Premiere 26.3 features](https://helpx.adobe.com/premiere/desktop/whats-new/whats-new.html)
- [Modern transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html)
