# @personalbrandlaunch Top-20 Production Benchmark

Captured and analyzed on 2026-08-03. This is a private production-pattern study, not a license to redistribute source media, copy scripts, impersonate the creator, or reuse creator-specific claims. The implementation reproduces portable editorial grammar with original Isaiah Dupree topics, language, evidence, branding, assets, and offers.

## Sources And Scope

- User-selected style anchor: [The Power of Background Music](https://www.instagram.com/reel/DbfymuBhrC7/)
- Ranked current-year corpus: [SocialPruf @personalbrandlaunch](https://socialpruf.com/instagram/personalbrandlaunch)
- Longitudinal strategy analysis: [Content Copilot playbook](https://www.contentcopilot.so/playbook/personalbrandlaunch)
- Local corpus: 20 ranked public reels plus the style anchor; 247 MB; media is excluded from Git.
- Local evidence: 21 Whisper word-timestamp transcripts, 21 per-video JSON analyses, 21 twelve-frame storyboards, FFprobe media metadata, FFmpeg EBU R128 audio measurements, OpenCV face framing, and robust visual-change detection.
- Reproducible source manifest: `personalbrandlaunch-top20-source.json`.
- Reproducible analyzer: `../scripts/analyze_creator_benchmark.py`.
- Aggregate machine measurements: `personalbrandlaunch-top20-measurements.json`.

## Executive Finding

The benchmark is not primarily successful because of decorative editing. It packages one useful distinction into an instantly legible visual format. Eleven of the ranked 20 are comparisons or tests; five are ratings, lists, or taxonomies. The production grammar is stable enough to recognize but flexible enough to teach different ideas.

The repeatable engine is:

1. A three-part hook in the first two seconds: spoken claim, visual contrast, and a short written label.
2. A presenter-led explanation with one visible state change per idea.
3. A comparison, score, framework, test, or story structure that makes the lesson scannable without sound.
4. A visual reset near every two seconds in compact educational formats.
5. A CTA chosen for a business purpose after the value is delivered.

The biggest strategic lesson is idea compression. The strongest reels do not try to cover a whole topic. They make one distinction memorable: important versus unimportant, reels versus stories, weak hook versus strong hook, following versus personal brand, or tool stack versus content system.

## Corpus Measurements

| Metric | Measured result | Production implication |
|---|---:|---|
| Ranked reels | 20 | Enough to identify recurring families, not enough to infer private retention curves. |
| Mean / median duration | 35.50s / 33.38s | Default to 28-38 seconds; use 45-60 seconds only when examples earn the time. |
| Duration range | 11.91-66.50s | The idea determines duration; there is no single magic length. |
| Mean / median speech rate | 214 / 224 WPM | Delivery is compressed and pause-light. Isaiah target is a clearer 175-195 WPM. |
| Detected visual reset | every 2.84s mean | Comparison/list formats cluster around 1.68-2.47s; use 2.0s as the default. |
| Mean detected resets | 13.05 per reel | A reset may be a cut, crop, label, insert, effect, or proof visual. |
| Presenter face present | 91.7% of sampled frames | The face is the narrative spine; inserts explain phrases rather than replace the presenter. |
| Non-presenter proxy | 8.3% of sampled frames | The benchmark often overlays examples instead of leaving the presenter entirely. |
| Median face center | x 48.7%, y 44.9% | Center horizontally; place eyes/face slightly above geometric center. |
| Integrated loudness | -14.30 LUFS mean | Loud, platform-ready masters; our safer target remains -16 LUFS. |
| True peak | -0.36 dBFS mean | The benchmark is hot. Our gate remains no higher than -1 dBFS. |
| Detected silence | 0.09s mean | Dead air is removed aggressively. Preserve intentional micro-pauses, not empty gaps. |

The cut detector samples six frames per second and finds robust luminance changes. It can undercount subtle same-background jump cuts and high-motion montage edits. Storyboards and transcript boundaries remain required editorial evidence.

## Content Portfolio

The longitudinal analysis covers 1,423 reels from March 2023 through April 2026: 170.8 million total views and roughly 120,000 average views. Its goal mix is 87.1% viral, 7.9% client, 3.8% community, and 1.1% brand. That is a distribution strategy: reach content funds attention; selected client and identity posts convert or deepen it.

Hook mix across that larger sample:

| Hook | Share | Average views | Role |
|---|---:|---:|---|
| Curiosity | 24.1% | 137.8K | Opens an information gap. |
| Contrarian | 17.5% | 107.2K | Rejects familiar advice. |
| Result-first | 17.1% | 124.3K | Shows the payoff before process. |
| List | 15.0% | 110.9K | Promises bounded value. |
| Question | 10.0% | 127.7K | Invites prediction or self-classification. |
| Story | 6.9% | 112.0K | Builds identity and connection. |
| Warning | 5.8% | 100.7K | Frames avoidable loss. |
| Shock | 1.6% | 117.7K | Uses a surprising statement sparingly. |
| Comparison | 1.1% | 134.6K | Low usage but strong mean performance. |

Format mix across the larger sample is 73% talking head. Comparison is only 6.6% of posts but leads the listed formats at 152.9K average views. The ranked current-year set leans much harder into comparisons: 11 of 20.

## Visual Grammar

### Frame Architecture

1. Top 0-8%: breathing room for platform crop and visual comfort.
2. Top 8-22%: three-to-eight-word written hook in bold condensed type.
3. Middle 22-62%: presenter face and gestures, centered near x 49%, y 45%.
4. Center-lower 58-76%: stable spoken captions, usually one or two short lines.
5. Bottom 80-100%: reserved for platform controls, caption, username, and interaction UI.

The written hook and captions perform different jobs. The headline labels the idea; captions preserve the spoken sentence. Copying the sentence into both places creates competition and was explicitly blocked in the new benchmark contract.

### Type And Color

- Headline: heavy condensed sans, uppercase, three to eight words, high-contrast lime/yellow in the source benchmark.
- Isaiah adaptation: condensed heavy sans with `#20D5C2` teal, white, and near-black stroke; no creator-identical cover treatment.
- Captions: white with dark outline; one semantic word may use teal; no gray lower bar.
- Labels: large single words, ratings, A/B markers, or category names positioned near the thing they explain.
- Graphic background: flat, bright field only for full-screen diagrams or proof boards; never as an always-on lower third.

### Camera And Body

- The presenter is generally medium or medium-close, with hands available for pointing.
- The face remains centered while labels and examples occupy side or upper negative space.
- Punch-ins communicate a new beat. They are not random breathing zooms.
- Green-screen/composite scenes keep the presenter visible while examples appear behind or beside them.
- Story/identity reels are the exception: archival images and clips can temporarily become the primary frame.

### B-Roll And Generated Assets

The benchmark's sampled presenter presence is 91.7%, so it does not use constant full-screen B-roll. It frequently uses explanatory overlays, screenshots, example clips, labels, and diagrams while retaining the speaker. For Isaiah, raise the semantic visual target to 20-35% of runtime because the product story benefits from showing interfaces and evidence, but preserve the same rule: every insert must answer the sentence currently being spoken.

Preferred visual order:

1. First-party proof: actual Premiere timeline, project receipt, dashboard, output, metric, or workflow state.
2. Generated 2D explainer: comparison ladder, five-step loop, scorecard, decision tree, or highlighted phrase.
3. Screen demonstration: a tool performing the named action.
4. Licensed provider footage: Pexels/Pixabay only when a real-world metaphor explains the idea.
5. Decorative footage: reject.

## Caption Engineering

- Keep one stable caption group visible for at least 18 frames at 30 fps.
- Snap cue boundaries to frames.
- Bridge accidental gaps of six frames or less.
- Compile caption graphics into one continuous ProRes 4444 alpha overlay so Premiere receives one clip, not dozens of flicker-prone clips.
- Use four to five words per group for compact formats and five to six for stories.
- Highlight one meaningful word, not every word in sequence.
- Keep captions around y 68% with at least 20% bottom UI reserve.
- The callout must be a takeaway, score, contrast label, proof, or chapter; it cannot restate the caption.

## Editing Cadence

The strongest compact reels use a visible change roughly every two seconds. A change can be:

- hard jump cut;
- wide/medium/close camera angle;
- purposeful crop pulse;
- A/B label swap;
- item score or category label;
- example clip or screenshot;
- animated arrow or diagram state;
- background replacement;
- proof card;
- short sound effect synchronized to an on-screen event.

Do not interpret the rule as "insert unrelated stock every two seconds." The meaning changes first; the picture follows.

## Audio Grammar

The mastered stereo files average -14.30 LUFS and -0.36 dBFS true peak. Exact music-bed gain cannot be recovered from a mixed master. The linked background-music reel demonstrates the qualitative rule: music materially changes emotional interpretation, but it is distinct from choosing a trending audio.

Isaiah mix contract:

- Dialogue target: -16 LUFS integrated, tolerance +/-2 LU, true peak <= -1 dBFS.
- Music: begin around -28 to -24 LUFS under speech; duck 8-12 dB when narration is active.
- SFX: use for visible UI actions, label arrivals, comparisons, transitions, and proof reveals; not every cut.
- Silence: remove accidental gaps over 250 ms, but preserve pauses that improve comprehension.
- Music family: restrained electronic for teaching, warmer pulse for story/identity, percussive ticks for comparisons, no copyrighted commercial song unless usage rights are recorded.

## Hook Construction

Every benchmark-derived post must pass a triple-hook gate:

| Layer | Job | Isaiah example |
|---|---|---|
| Spoken | State the tension or result | "Most creators are stacking AI tools, not building a content system." |
| Written | Condense/reframe in 3-8 words | `TOOL STACK VS. CONTENT SYSTEM` |
| Visual | Make the distinction visible | Disconnected tool tiles snap into one traced production line. |

The written hook fails QA when semantic overlap with the spoken hook exceeds 72%. This prevents captions from masquerading as callouts.

## CTA System

In the measured ranked set, the final eight seconds contain 15 follow CTAs, one keyword-comment CTA, and four implicit/no CTAs. The larger longitudinal analysis reports 54.2% follow, 35.6% comment, 5.8% none, 2.3% link in bio, 1.8% DM keyword, and 0.2% book-call.

The CTA is a funnel decision:

- Audience growth: soft follow after value.
- Lead magnet: keyword comment after the asset is demonstrated.
- Authority/trust: no CTA or a soft follow.
- Client conversion: qualify the viewer, then keyword comment or direct offer.
- Do not use a generic follow CTA in the opening or before the lesson lands.

The larger analysis reports a 2.01% comment rate for comment CTAs versus 0.06% for follow CTAs. That does not make comment the universal winner; it means the formats serve different goals.

## Per-Reel Production Matrix

`Reset` is the measured mean seconds between robust visual changes. `Face` is presenter-face presence, not a full semantic B-roll classifier.

| # | Reel | Views | Length | WPM | Reset | Face | Hook | CTA |
|---:|---|---:|---:|---:|---:|---:|---|---|
| 1 | Sound Effects 101 | 3.34M | 61.3s | 45 | 3.07s | 100% | Direct taxonomy/demonstration | Implicit asset delivery |
| 2 | Important vs. Not Important | 1.83M | 66.5s | 190 | 2.38s | 99% | Binary contrast | Follow |
| 3 | Slow Growth vs. Fast Growth | 1.81M | 11.9s | 166 | 1.99s | 96% | Weekly comparison | Service keyword in caption/audio tail |
| 4 | Same Hook, Different Delivery | 1.72M | 36.5s | 245 | 3.04s | 100% | Repeated controlled test | Keyword comment |
| 5 | Rating Social Advice | 1.69M | 18.5s | 178 | 2.06s | 100% | Rapid rating list | Follow |
| 6 | Music For Short Type | 1.58M | 21.7s | 229 | 1.98s | 100% | Use-case list | Follow |
| 7 | Reels vs Carousels vs Stories | 1.47M | 30.3s | 208 | 2.02s | 100% | Three-column taxonomy | Follow |
| 8 | More Cuts = More Engagement | 1.38M | 26.1s | 255 | 1.86s | 85% | Contrarian/direct claim | Follow |
| 9 | Ava & Ben Identity Story | 1.16M | 48.6s | 254 | 8.11s* | 46% | Personal identity | Follow journey |
| 10 | Telling a Story vs Storytelling | 1.08M | 25.6s | 209 | 1.83s | 100% | Binary contrast | Follow |
| 11 | Which Video Got More Views? | 1.05M | 26.9s | 265 | 2.99s | 96% | Prediction/A-B test | Implicit lesson |
| 12 | 100 vs 100K vs 1M Hook | 853K | 47.7s | 236 | 2.39s | 100% | Escalating comparison | Implicit lesson |
| 13 | Ava & Ben Identity Story | 824K | 48.6s | 254 | 8.11s* | 47% | Personal identity | Follow journey |
| 14 | Following vs Personal Brand | 788K | 42.0s | 246 | 2.47s | 87% | Self-classification question | Follow |
| 15 | Which Video Got More Views? | 743K | 32.9s | 233 | 1.94s | 97% | Prediction/A-B dialogue | Embedded follow endorsement |
| 16 | Educational vs Story vs Authority | 733K | 27.1s | 212 | 2.26s | 100% | Three-column taxonomy | Follow |
| 17 | Instagram 101 | 732K | 13.5s | 196 | 1.68s | 96% | Compressed mapping | Follow |
| 18 | Five Main Content Types | 719K | 52.5s | 247 | 2.10s | 85% | Numbered taxonomy/dialogue | Embedded follow endorsement |
| 19 | Reels vs Carousels vs Stories | 718K | 33.9s | 193 | 1.88s | 100% | Three-column taxonomy | Follow |
| 20 | Top Tools for Creators | 629K | 37.9s | 219 | 2.71s | 100% | Problem/tool replacement list | Follow |

`*` The automatic detector undercounts high-motion montage edits. Storyboard review shows substantially more visual changes than the hard-cut score alone.

## What Each Family Is Doing

### Comparison Ladder

The presenter repeats the same dimensions across two or three columns. Each sentence fills another row, so the viewer can predict the structure and waits for the next distinction. Best use for Isaiah: tool versus system, automation versus autonomy, generated export versus editable project, untracked asset versus provenance receipt.

### Hook Test

The topic remains constant while one variable changes. The viewer predicts A or B, receives the answer, then learns the mechanism. Best use for Isaiah: generic hook versus proof-first hook, decorative B-roll versus semantic proof, static crop versus face-safe crop, unstable captions versus continuous overlay.

### Rating/List

Each item receives a fast visible judgment and one reason. It works because the opinion is legible before the explanation finishes. Best use for Isaiah: rating AI video practices, ranking autonomous workflow stages, five production receipts, tools that save clicks versus systems that learn.

### Story/Authority

The edit alternates personal chronology, visual proof, and a transferable belief. It uses more archival footage and fewer repeated diagrams. Best use for Isaiah: building the Premiere plugin, failures that forced the receipt system, creator journey from manual edits to autonomous production, a client or product result with evidence.

### Contrarian Deconstruction

This family turns a familiar belief into an unresolved question: state the accepted advice, reject it immediately, explain the causal failure, and replace it with a usable rule. It is grounded in the corpus's contrarian/direct claims, especially the pattern behind “More Cuts = More Engagement,” but it avoids copying the benchmark's wording or examples.

Production contract:

- Spoken hook: one sentence naming the belief and the contradiction, finished by 1.8 seconds.
- Written hook: three to seven words; label the consequence rather than transcribing the sentence.
- Visual hook: tight 1.065x punch, direct eye contact, and a yellow myth/reality headline.
- Body: myth, why it feels true, failure mechanism, replacement rule, one real proof receipt.
- Captions: three-word groups at y 66%; emphasize the causal word, not every noun.
- Visual mix: presenter remains primary; one 2D mechanism diagram and one real proof insert.
- Cadence: 1.6-second target reset, mostly hard cuts; no decorative transition pack.
- Audio: restrained tension pulse; one strike when the myth breaks and one reveal cue for the replacement rule.
- CTA: soft follow for recurring education, or a keyword comment only when a relevant framework was shown.

Thirty-second beat map: 0.0-1.8 belief reversal; 1.8-5.0 why people believe it; 5.0-13.0 causal failure; 13.0-21.0 replacement rule; 21.0-26.0 proof; 26.0-30.0 synthesis and CTA. Reject the edit if it only says “this is wrong” without explaining why, if the callout repeats the caption, or if stock footage substitutes for causal proof.

Best Isaiah topics: more AI tools do not create autonomy; more cuts do not guarantee retention; more generated assets do not create a coherent scene; automation without receipts cannot learn.

### Screen-Proof Walkthrough

This family treats the interface as evidence. The outcome appears first, then a short sequence of visible actions demonstrates how it happened, and Isaiah returns on camera to interpret the result. It borrows the benchmark's presenter-plus-example rhythm while raising the evidence standard with real Premiere projects, timelines, manifests, and metrics.

Production contract:

- Spoken hook: result before process, with the exact thing being demonstrated named by 2 seconds.
- Written hook: a proof promise, not “watch me” filler; three to seven words in green.
- Visual hook: result frame or completed timeline, then return to the presenter.
- Body: outcome, action one, action two, verification receipt, interpretation.
- Captions: five-word groups at y 71% so they remain below the screen focal area and above platform controls.
- Visual mix: real video demonstrations only; diagrams are excluded from this preset.
- Cadence: action-matched hard cuts around 1.5 seconds; hold longer only when the cursor or timeline movement carries information.
- Audio: minimal technical pulse; interface sound only when an actual click, marker, export, or state change is visible.
- CTA: keyword comment after the project or map has been shown; no CTA before the verification receipt.

Thirty-six-second beat map: 0.0-2.0 outcome; 2.0-5.0 presenter promise; 5.0-19.0 two or three screen actions; 19.0-26.0 verification; 26.0-32.0 interpretation; 32.0-36.0 CTA. Reject the edit when the screen is unreadable, when B-roll does not match the narrated action, or when the presenter narrates clicks without explaining why they matter.

Best Isaiah topics: autonomous Premiere project creation, caption continuity checks, asset-provenance receipts, face-safe reframing, and retention metrics feeding the next production run.

### Before/After Reveal

This family opens on the finished state, deliberately returns to the weak starting state, compresses the mechanism into a few beats, and earns a second reveal. It is for transformations with inspectable evidence, not vague motivational claims.

Production contract:

- Spoken hook: name the transformation and the cost of the old state.
- Written hook: a directional promise such as `FROM TOOL PILE TO SYSTEM`.
- Visual hook: 0.4-0.8 second after-state flash, immediate before-state contrast, then presenter explanation.
- Body: after, before, two mechanism beats, proof, after revisited.
- Captions: four-word groups at y 67%; highlight changed states and mechanism verbs.
- Visual mix: complete evidence sequence, including real footage and the 2D process explanation.
- Cadence: 1.9-second target reset; strongest 1.07x crop pulse in the opening and a smaller 1.04x final reveal.
- Audio: rising proof pulse; one restrained cue on each state transition.
- CTA: ask for the map, checklist, or project only after the second after-state is visible.

Twenty-eight-second beat map: 0.0-1.2 after; 1.2-4.0 before; 4.0-8.0 stakes; 8.0-18.0 mechanism; 18.0-23.0 proof; 23.0-26.0 after revisited; 26.0-28.0 CTA. Reject the edit when before and after use unmatched conditions, when the result cannot be verified, or when the reveal is delayed so long that the promise feels withheld.

Best Isaiah topics: caption flicker before versus continuous overlays after; disconnected tools versus a traced content system; black-bar exports versus face-safe vertical framing; one-off generation versus a seven-style learning campaign.

## Exact 32-Second Comparison Template

| Time | Spoken function | Picture | Text/audio |
|---:|---|---|---|
| 0.00-0.40 | Contradiction begins | Tight face punch-in | 3-8 word written hook arrives with one impact. |
| 0.40-2.00 | Finish the claim | Split-screen contrast appears | Captions begin; written hook stays stable. |
| 2.00-5.00 | Define weak state | Presenter points left; weak label | One semantic SFX on label arrival. |
| 5.00-8.00 | Define strong state | Presenter points right; strong label | Hard cut or crop reset. |
| 8.00-18.00 | Three comparison dimensions | Rows appear one at a time | Reset every 1.7-2.2s; captions remain center-lower. |
| 18.00-25.00 | Proof/demonstration | Real timeline, receipt, or metric | Music ducks; proof label names the takeaway. |
| 25.00-29.00 | Synthesize belief | Return to clean face frame | No new decorative insert. |
| 29.00-32.00 | Goal-matched CTA | Keyword or follow instruction | CTA only after proof; leave bottom UI reserve clear. |

## Research Institution Contract

For every candidate topic, store:

1. Viewer problem in one sentence.
2. Search/audience evidence and timestamp.
3. One defensible distinction the post can teach.
4. Proof available from Isaiah's real systems.
5. Five hook angles: comparison, contrarian rating, result-first, question, and list.
6. Rejected alternatives and why they were weaker.
7. Recommended format family and CTA goal.
8. Claim/source map and words that must not be overstated.

Scoring weights:

- 30% viewer pain and relevance;
- 25% demonstrable first-party proof;
- 20% compression into one memorable distinction;
- 15% fit to a proven format family;
- 10% offer/CTA continuity.

Reject an idea when it lacks proof, requires copied creator claims, cannot be explained at a sixth-grade reading level, or needs unrelated B-roll to feel interesting.

## Premiere Preset Contract

Implemented format IDs:

- `benchmark-comparison-ladder`
- `benchmark-hook-test`
- `benchmark-rating-list`
- `benchmark-story-authority`

Shared gates:

- vertical 1080x1920, safe-fill only, no black bars;
- face anchored near x 50%, y 34-37% after crop compensation;
- top headline at y 8-10%, maximum eight words;
- caption anchor y 66-71%, bottom reserve 20%;
- one continuous alpha caption overlay;
- no caption/callout duplication;
- explanatory visuals only, six to eight maximum depending on format;
- hard cuts by default;
- dialogue-first mix;
- approval required before publishing benchmark experiments.

The original `authority-benchmark-matrix-v1` preset preserves the four-format baseline. The active expanded preset `authority-benchmark-expanded-v2` creates seven controlled variants from the same completed HeyGen source, schedules styles 48 hours apart, and records average percentage viewed as the primary metric with completion, three-second view rate, and engagement as guardrails.

## Original Isaiah Adaptation

Topic: **An AI tool stack is not an autonomous content system.**

Spoken hook: "Most creators are stacking AI tools, not building a content system."

Written hook: `TOOL STACK VS. CONTENT SYSTEM`

Visual hook: disconnected tool tiles snap into one traced production line while Isaiah points between the two states.

Core lesson: a content system connects five receipts: audience problem, script decision, licensed visuals, Premiere edit, and retention result.

CTA: `Comment SYSTEM and I will share the production map I am building.`

The production-ready HeyGen/ElevenLabs/Premiere board is `../examples/authority-benchmark-isaiah-board.json`. It uses the portrait Isaiah avatar, `IsaiahDupree_v2` through ElevenLabs, semantic Pexels/Pixabay requests, one generated 2D process explainer, native captions, the no-flicker overlay path, and the seven-style derivative experiment matrix.

## QA Checklist

- Triple hook visible and understandable by 2.0 seconds.
- Written hook is 3-8 words and semantic overlap with spoken hook is <=72%.
- First useful distinction lands by 5 seconds.
- Visual reset median is 1.5-2.6 seconds for compact formats.
- Every B-roll insert maps to a timestamped phrase and explanatory purpose.
- Presenter face remains inside safe framing; no exposed canvas or black bars.
- Headline, face, captions, and platform UI reserve do not collide.
- Caption overlay is one clip, frame-aligned, gap-bridged, and flicker-free.
- No gray lower bar.
- Callouts state takeaways, labels, scores, or proof; never captions.
- Dialogue is -18 to -14 LUFS with true peak <= -1 dBFS.
- Claims have receipts.
- CTA matches the campaign goal and appears after value.
- Original scripts and original Isaiah branding only.

## Live Validation Receipt

The original Isaiah board `isaiah-tool-stack-vs-content-system-v1` completed two independently judged revisions in Premiere. V1 won with a 90.7 score; V2 scored 89.8. The release render passed framing with no exposed canvas or black bars, and automatic dialogue recovery brought the final mix to -16.9 LUFS and -1.2 dBFS true peak without repeating the paid HeyGen generation.

The final derivative campaign is `isaiah-authority-benchmark-style-matrix-v4`. It reused the clean HeyGen scene files and produced four editable Premiere projects plus four 1080x1920 renders:

- each render is 21.067 seconds against a 21.08-second contract;
- each timeline has two clean presenter clips, three semantic inserts, and one continuous caption/headline overlay;
- each style has its own written hook and accent treatment;
- each caption plan contains 18 frame-aligned graphics with a 12-frame minimum;
- all four caption continuity reports pass with no rapid transitions, accidental gaps, micro-gaps, or off-frame boundaries;
- all four structural, pixel, frame, duration, and audio gates pass;
- the 12 publication cells remain approval-gated and unpublished.

The final release was copied to My Passport under `VideoFactory/ProductionBoards/isaiah-authority-benchmark-v1`, and the derivative projects/renders were copied under `VideoFactory/ShortForm`.

The three-format expansion was then validated in campaign `isaiah-authority-benchmark-three-new-styles-v1` against the same clean HeyGen source range:

- all three Premiere projects and 1080x1920 renders are 23.4 seconds and approval-gated;
- contrarian deconstruction uses the generated mechanism diagram plus analytics proof;
- screen-proof walkthrough uses the Premiere and analytics video demonstrations and excludes the diagram;
- before/after reveal keeps the complete three-asset evidence sequence;
- every variant has 21 frame-aligned caption graphics, a 12-frame minimum, and zero rapid transitions, accidental gaps, micro-gaps, or off-frame boundaries;
- all three passed structural, pixel, framing, duration, and audio checks at -16.2 LUFS and -1.2 dBFS true peak;
- the nine new publication cells remain unpublished.

## Experiment Plan

Use one HeyGen performance and one source range for all seven styles. Do not change voice, topic, duration band, post time class, thumbnail promise, or CTA while comparing editing families. Run at least two replications per style and 500 views per style before promotion. Primary metric: average percentage viewed. Guardrails: three-second view rate, completion rate, engagement rate, and negative comment quality. Promote only when the practical improvement is at least 8%; otherwise replicate.

This benchmark is a quality floor, not a creative ceiling. The goal is recognizably clear, comparison-led education with better proof, safer audio, more explanatory first-party visuals, stable captions, and a learning loop the benchmark creator cannot supply for Isaiah's business.
