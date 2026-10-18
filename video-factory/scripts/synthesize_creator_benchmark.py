#!/usr/bin/env python3
"""Turn measured creator-reel evidence into an original, brand-safe production playbook."""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter
from pathlib import Path


PILLARS = [
    {
        "id": "receipts-over-renders",
        "goal": "authority",
        "proof": "Show a live artifact, project, metric, or audit receipt from Isaiah's operating stack.",
        "topics": [
            "The 100-video benchmark behind this content system",
            "A finished AI video is not proof of a working system",
            "The five receipts behind every autonomous video",
            "What the Premiere project proves that an MP4 cannot",
            "I measured 100 reels instead of copying one viral edit",
            "The difference between a demo and a production receipt",
            "How every B-roll choice keeps its source and license",
            "Why export success is not release approval",
            "The audit trail behind one five-minute video",
            "What a real AI editing experiment records",
            "The caption test that catches flicker before publishing",
            "How I know a video did not expose black bars",
            "The evidence packet I want every agent to produce",
            "Seven edits, one source, one controlled variable",
            "How viewer retention changes the next production run",
            "The exact artifacts inside an autonomous Premiere job",
            "Why generated volume without lineage is a dead end",
            "The quality gates between render and publish",
            "How one failed edit becomes a reusable operating rule",
            "My proof-first standard for talking about AI systems",
        ],
    },
    {
        "id": "manual-work-tax",
        "goal": "lead-magnet",
        "proof": "Demonstrate a before/after workflow and quantify the handoffs, checks, or repeated actions removed.",
        "topics": [
            "The hidden tax in opening six tools for one video",
            "Manual asset hunting versus a production asset broker",
            "Why copying captions between apps keeps breaking edits",
            "The twelve handoffs hiding inside one short-form post",
            "What creators still do manually after buying AI tools",
            "The real bottleneck is deciding what to make next",
            "Manual revisions versus receipt-backed revisions",
            "Why random B-roll wastes more time than it saves",
            "The cost of rebuilding a Premiere project from zero",
            "How one long-form source replaces seven recording sessions",
            "The approval step that should never be automated away",
            "Why a downloads folder is not an asset system",
            "The editing work agents should handle before you wake up",
            "Three checks that prevent expensive regeneration",
            "Stop paying twice for the same presenter footage",
            "Where autonomous video pipelines usually stall",
            "The fastest way to remove repetitive caption cleanup",
            "Why scheduling more posts does not fix a broken workflow",
            "The production tasks that deserve human taste",
            "How I turned a five-hour edit checklist into a traceable run",
        ],
    },
    {
        "id": "own-your-infra",
        "goal": "client-conversion",
        "proof": "Open the owned service, schema, local project, or storage path and show the control boundary.",
        "topics": [
            "Your automation is rented if you cannot inspect the decisions",
            "Why I keep Premiere as the editable master",
            "The difference between owning a workflow and renting a button",
            "What happens when a publishing provider goes down",
            "The local control plane behind my video factory",
            "Why agents need schemas before they need more prompts",
            "How every production service announces its capabilities",
            "The safe way to let agents open and edit Premiere projects",
            "Why API-first publishing needs an approval gate",
            "How I archive complete projects to My Passport",
            "The service registry that makes video capabilities discoverable",
            "Why source assets and project files move together",
            "The difference between a workflow log and an audit record",
            "How I prevent one provider from owning the whole pipeline",
            "Why local-first does not mean disconnected",
            "The recovery path when Premiere or UXP stops responding",
            "How autonomous systems resume without repeating paid work",
            "The permissions boundary every publishing agent needs",
            "Why I keep research separate from campaign pressure",
            "The infrastructure test I run before every production session",
        ],
    },
    {
        "id": "speed-to-shipped",
        "goal": "audience-growth",
        "proof": "Show timestamps, version history, completed outputs, and the next measurable experiment.",
        "topics": [
            "I turned 100 viral videos into 80 original ideas",
            "One five-minute generation, seven short-form experiments",
            "How fast can an agent build an editable Premiere campaign",
            "From market signal to finished project in one traced run",
            "The content matrix that replaces blank-page brainstorming",
            "How to ship more videos without lowering the quality gate",
            "Why one source asset should produce a month of experiments",
            "The seven short styles I test from the same speech",
            "How I choose the next video before generating anything",
            "The fastest useful test of a new editing style",
            "How an 80-idea backlog stays tied to real audience problems",
            "The one-generation rule that protects production budget",
            "How I turn a benchmark into a reusable Premiere preset",
            "What changed after analyzing eighty more creator videos",
            "How to test hooks without contaminating the whole edit",
            "The production board that ranks, revises, and archives",
            "Why finished projects matter more than automation screenshots",
            "The fastest path from long-form proof to vertical reach",
            "How every published result updates the next brief",
            "Building a content operating system one campaign at a time",
        ],
    },
]


def safe(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).replace("|", "\\|").strip()


def count_words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text))


def idea_hook(topic: str, hook_family: str) -> str:
    if hook_family == "question-or-prediction":
        return f"What if {topic[0].lower() + topic[1:]}?"
    if hook_family in {"comparison-ladder-or-contrast", "comparison-or-contrast"}:
        return f"There are two ways to do this: {topic[0].lower() + topic[1:]}."
    if hook_family == "outcome-or-proof":
        return f"I tested this in a live production: {topic[0].lower() + topic[1:]}."
    if hook_family == "list-or-taxonomy":
        return f"Here are the three layers behind this: {topic[0].lower() + topic[1:]}."
    if hook_family == "personal-story":
        return f"I learned this by building the system myself: {topic[0].lower() + topic[1:]}."
    if hook_family == "contrarian-or-correction":
        return f"The common advice misses the real issue: {topic[0].lower() + topic[1:]}."
    return f"Here is the operating rule: {topic[0].lower() + topic[1:]}."


def cta(goal: str) -> str:
    return {
        "authority": "End after the proof, with no hard CTA.",
        "lead-magnet": "Invite a keyword comment for the relevant workflow map only after the demonstration.",
        "client-conversion": "Invite qualified operators to request an audit after showing the control boundary.",
        "audience-growth": "Use a soft follow CTA tied to the next measured build-in-public episode.",
    }[goal]


def make_ideas(rows: list[dict]) -> list[dict]:
    anchors = sorted(rows, key=lambda row: row["rank"])[:20]
    ideas = []
    number = 1
    for pillar in PILLARS:
        for index, topic in enumerate(pillar["topics"]):
            anchor = anchors[index]
            ideas.append({
                "id": f"idea-{number:03d}",
                "pillar": pillar["id"],
                "topic": topic,
                "spokenHook": idea_hook(topic, anchor["hookFamily"]),
                "writtenHook": safe(topic).upper()[:64],
                "formatFamily": anchor["formatFamily"],
                "benchmarkPattern": {
                    "shortcode": anchor["shortcode"],
                    "title": anchor["title"],
                    "url": anchor["url"],
                    "adaptation": "Structure only; do not reuse wording, footage, brand elements, or claims.",
                },
                "requiredProof": pillar["proof"],
                "cta": cta(pillar["goal"]),
                "longFormPotential": index in {0, 3, 8, 13, 19},
            })
            number += 1
    return ideas


def table_counts(counter: dict[str, int]) -> list[str]:
    total = sum(counter.values()) or 1
    return [f"| {safe(name)} | {count} | {count / total:.1%} |" for name, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--aggregate", type=Path, required=True)
    parser.add_argument("--research", type=Path, required=True)
    parser.add_argument("--ideas-output", type=Path, required=True)
    parser.add_argument("--report-output", type=Path, required=True)
    args = parser.parse_args()

    rows = json.loads(args.corpus.read_text())
    aggregate = json.loads(args.aggregate.read_text())
    research = json.loads(args.research.read_text())
    ideas = make_ideas(rows)
    args.ideas_output.parent.mkdir(parents=True, exist_ok=True)
    args.ideas_output.write_text(json.dumps({
        "schemaVersion": 1,
        "creator": "Isaiah Dupree",
        "sourceCorpusSize": len(rows),
        "adaptationPolicy": "Use measured production grammar only. All topics, wording, claims, footage, graphics, and offers are original to Isaiah.",
        "ideas": ideas,
    }, indent=2) + "\n")

    durations = [row["media"]["durationSeconds"] for row in rows]
    engagement_ranked = sorted(rows, key=lambda row: (row.get("views", 0), row.get("likes", 0) + row.get("comments", 0)), reverse=True)
    lines = [
        "# @personalbrandlaunch 100-Reel Production Benchmark",
        "",
        "## Scope and ethics",
        "",
        f"This private benchmark measures {len(rows)} public reels. It extracts production grammar and never treats the creator's media, wording, brand design, or claims as reusable assets. Generated Isaiah posts must use original topics, language, proof, graphics, footage, and offers.",
        "",
        "The first 20 reels preserve the prior SocialPruf ranking. The next 80 are unique public timeline reels captured on the date in the source manifest. Instagram's logged-out response did not expose view counts for those additions, so view-ranked claims apply only to the preserved top 20; likes and comments remain visible for the expansion.",
        "",
        "## Executive findings",
        "",
        f"- Median reel duration: {statistics.median(durations):.1f} seconds; range: {min(durations):.1f}-{max(durations):.1f} seconds.",
        f"- Median speech rate: {aggregate['pacing']['medianWordsPerMinute']:.0f} words per minute.",
        f"- Mean detected visual interval: {aggregate['pacing']['meanSecondsPerDetectedCut']:.2f} seconds.",
        f"- Mean presenter-face presence: {aggregate['composition']['meanPresenterFacePresenceRatio']:.0%}; non-presenter visual proxy: {aggregate['composition']['meanNonPresenterVisualProxyRatio']:.0%}.",
        f"- Mean integrated loudness: {aggregate['audio']['meanIntegratedLufs']:.1f} LUFS; mean true peak: {aggregate['audio']['meanTruePeakDbfs']:.1f} dBFS.",
        "- The repeatable unit is a format, not a copied topic: comparison ladders, rating taxonomies, proof case studies, tutorials, founder stories, and contrarian corrections can all carry Isaiah's first-party evidence.",
        "- The opening works as three coordinated layers: a spoken promise, a short written reframing, and a visual demonstration. These layers should agree without repeating the same sentence.",
        "- Presenter footage supplies trust and continuity. B-roll, diagrams, screen proof, labels, and sound cues appear when they explain the sentence currently being spoken.",
        "- Calls to action are downstream of value. Keyword comments fit an actual resource or service; follows fit an ongoing series; authority posts may end after the proof.",
        "",
        "## Why this is timely for Isaiah",
        "",
        f"The current public research packet recommends **{safe(research['synthesis']['recommendedTopic'])}**. Its central audience problem is: {safe(research['synthesis']['audienceProblem'])}",
        "",
        "That topic fits Isaiah's builder-operator brand because the benchmark, transcripts, analysis, idea backlog, Premiere project, seven derivatives, and QA records are all inspectable first-party proof. It avoids the generic claim that AI creates more content and instead demonstrates a controlled evidence-to-production loop.",
        "",
        "## Format distribution",
        "",
        "| Family | Reels | Share |",
        "|---|---:|---:|",
        *table_counts(aggregate["formatFamilies"]),
        "",
        "## Hook distribution",
        "",
        "| Hook | Reels | Share |",
        "|---|---:|---:|",
        *table_counts(aggregate["hookFamilies"]),
        "",
        "## CTA distribution",
        "",
        "| CTA | Reels | Share |",
        "|---|---:|---:|",
        *table_counts(aggregate["ctaFamilies"]),
        "",
        "## Reusable production specification",
        "",
        "1. Research: name one audience problem, one distinction, one first-party proof asset, and one platform-native promise before scripting.",
        "2. Hook: resolve the promise within two seconds through spoken, written, and visual layers. Written text is three to eight words and is not a transcript line.",
        "3. Structure: choose one dominant format family. Do not combine every pattern in one short.",
        "4. Pacing: target a meaningful visual reset around the measured interval. A reset may be a crop, label, diagram, proof capture, B-roll insert, or scene change; it must clarify the active thought.",
        "5. Framing: preserve safe fill, place the face near the upper-middle focal zone, keep the headline above the face, captions center-lower, and the bottom platform-control reserve empty.",
        "6. Captions: render one continuous frame-aligned overlay with stable word groups and one highlighted keyword. Never show a gray caption bar and never rebuild the overlay per frame.",
        "7. Proof: show the named artifact while the claim is made. Decorative stock footage does not count as evidence.",
        "8. Sound: keep dialogue dominant, use low music as emotional support, and reserve effects for visible events or conceptual transitions.",
        "9. CTA: deliver the value first, then select no CTA, follow, keyword comment, or qualified service invitation according to the post's business goal.",
        "10. Experiment: change one primary variable across matched variants and preserve source, edit, publish, and metrics lineage.",
        "",
        "## Isaiah 80-idea backlog",
        "",
        "The backlog contains 20 ideas in each brand pillar. Every row cites the benchmark structure that inspired the format while requiring original Isaiah proof.",
        "",
        "| ID | Pillar | Topic | Format | Required proof |",
        "|---|---|---|---|---|",
    ]
    for idea in ideas:
        lines.append(f"| {idea['id']} | {safe(idea['pillar'])} | {safe(idea['topic'])} | {safe(idea['formatFamily'])} | {safe(idea['requiredProof'])} |")
    lines.extend([
        "",
        "## Per-video measurement index",
        "",
        "| Rank | Reel | Title | Sec | WPM | Visual interval | Presenter | Format | Hook | CTA | Views | Likes | Comments |",
        "|---:|---|---|---:|---:|---:|---:|---|---|---|---:|---:|---:|",
    ])
    for row in sorted(rows, key=lambda item: item["rank"]):
        lines.append(
            f"| {row['rank']} | [{row['shortcode']}]({row['url']}) | {safe(row['title'])} | "
            f"{row['media']['durationSeconds']:.1f} | {row['transcript'].get('wordsPerMinute', 0):.0f} | "
            f"{row['visual']['meanSecondsPerDetectedCut']:.2f} | {row['visual']['presenterFacePresenceRatio']:.0%} | "
            f"{safe(row['formatFamily'])} | {safe(row['hookFamily'])} | {safe(row['ctaFamily'])} | "
            f"{row.get('views', 0)} | {row.get('likes', 0)} | {row.get('comments', 0)} |"
        )
    lines.extend([
        "",
        "## Highest visible-signal references",
        "",
    ])
    for row in engagement_ranked[:20]:
        signal = row.get("views", 0) or row.get("likes", 0) + row.get("comments", 0)
        metric = "views" if row.get("views", 0) else "visible likes + comments"
        lines.append(f"- [{safe(row['title'])}]({row['url']}): {signal:,} {metric}; {safe(row['formatFamily'])}; {safe(row['hookFamily'])}.")
    lines.extend([
        "",
        "## Measurement limits",
        "",
        "- Hard cuts use six-frame-per-second luminance differences and can miss subtle jump cuts or count very strong motion as a cut.",
        "- Presenter absence is a B-roll/graphics proxy, not semantic scene recognition.",
        "- Whisper supplies word timestamps; names and heavily mixed phrases may require editorial correction.",
        "- Public engagement is not private retention. Format promotion must wait for Isaiah's matched posting experiments.",
        "- This report identifies portable production patterns, not a license to imitate the creator's identity or redistribute source media.",
        "",
        "## Generated artifacts",
        "",
        f"- Per-video analyses: `{args.corpus.parent}`",
        f"- Current public trend packet: `{args.research}`",
        f"- Original Isaiah idea backlog: `{args.ideas_output}`",
        "",
        f"Report word count excluding JSON backlog: {count_words(' '.join(lines)):,}.",
    ])
    args.report_output.parent.mkdir(parents=True, exist_ok=True)
    args.report_output.write_text("\n".join(lines) + "\n")
    print(json.dumps({"report": str(args.report_output), "ideas": len(ideas), "videos": len(rows)}))


if __name__ == "__main__":
    main()
