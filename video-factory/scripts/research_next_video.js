#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { TrendScout } = require("../lib/trend-scout");

const DEFAULT_QUERIES = [
    "AI content creation system creator workflow",
    "I analyzed viral videos content strategy",
    "AI agents content marketing workflow",
];

async function main() {
    const output = process.argv[2];
    if (!output) throw new Error("Usage: research_next_video.js /absolute/output.json [query ...]");
    const queries = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT_QUERIES;
    const scout = new TrendScout({ YT_DLP_BIN: process.env.YT_DLP_BIN || "/opt/homebrew/bin/yt-dlp" });
    const results = [];
    for (const query of queries) {
        results.push(await scout.research({
            trend: { enabled: true, query, limit: 8, maxAgeDays: 180, region: "US" },
        }));
    }
    const candidates = results.flatMap((result) => result.candidates);
    const packet = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source: "yt-dlp public YouTube metadata",
        evidenceLimits: "Public title and engagement metadata only. Private retention data is unavailable.",
        queries,
        results,
        synthesis: {
            recommendedTopic: "I Analyzed 100 Viral Videos and Turned Them Into an Autonomous Content System",
            audienceProblem: "Creators have more AI tools and more output, but no evidence-backed system for deciding what to make, how to edit it, or what to change next.",
            thesis: "The durable advantage is not AI volume. It is a traceable loop from market evidence to production rules to measurable experiments.",
            proofAssets: [
                "A private 100-reel benchmark with transcripts and per-video measurements",
                "An 80-idea backlog derived from repeatable structures and Isaiah's four content pillars",
                "One five-minute presenter source edited into seven controlled short-form variants",
                "Premiere project, asset, QC, archive, and experiment receipts",
            ],
            publicCandidateCount: candidates.length,
        },
    };
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(packet, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ output: path.resolve(output), candidates: candidates.length })}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
