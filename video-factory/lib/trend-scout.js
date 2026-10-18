const { nowIso, run } = require("./util");

function percentile(values, value) {
    if (values.length <= 1) return 1;
    const below = values.filter((item) => item < value).length;
    return below / (values.length - 1);
}

function normalizeWords(text) {
    return new Set(String(text || "").toLowerCase().match(/[a-z0-9]+/g) || []);
}

function relevance(query, title, description) {
    const wanted = normalizeWords(query);
    const actual = normalizeWords(`${title || ""} ${description || ""}`);
    if (wanted.size === 0) return 0;
    return [...wanted].filter((word) => actual.has(word)).length / wanted.size;
}

class TrendScout {
    constructor(config) {
        this.ytDlpBin = config.YT_DLP_BIN || "/opt/homebrew/bin/yt-dlp";
    }

    async research(board) {
        if (!board.trend.enabled) {
            return { generatedAt: nowIso(), query: board.trend.query, candidates: [], disabled: true };
        }
        const search = `ytsearch${Math.min(50, board.trend.limit * 3)}:${board.trend.query}`;
        const printTemplate = "%(.{id,title,view_count,like_count,comment_count,duration,timestamp,upload_date,channel,channel_url,webpage_url,thumbnail,description,original_url})j";
        const { stdout } = await run(this.ytDlpBin, [
            "--skip-download",
            "--ignore-errors",
            "--no-warnings",
            "--print", printTemplate,
            "--geo-bypass-country", board.trend.region,
            search,
        ], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
        const cutoff = Date.now() - board.trend.maxAgeDays * 86400000;
        const raw = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        const candidates = raw.map((item) => {
            const publishedAt = item.timestamp ? new Date(item.timestamp * 1000) : null;
            const ageHours = publishedAt ? Math.max(1, (Date.now() - publishedAt.getTime()) / 3600000) : null;
            const views = Number(item.view_count || 0);
            const likes = Number(item.like_count || 0);
            const comments = Number(item.comment_count || 0);
            return {
                id: item.id,
                url: item.webpage_url || item.original_url,
                title: item.title || "",
                channel: item.channel || item.uploader || "",
                channelUrl: item.channel_url || item.uploader_url || null,
                publishedAt: publishedAt ? publishedAt.toISOString() : null,
                durationSeconds: Number(item.duration || 0),
                views,
                likes,
                comments,
                viewVelocity: ageHours ? views / ageHours : 0,
                engagement: views > 0 ? (likes + 2 * comments) / views : 0,
                nicheRelevance: relevance(board.trend.query, item.title, item.description),
                thumbnail: item.thumbnail || null,
                channelOutlier: null,
            };
        }).filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= cutoff)
            .slice(0, board.trend.limit);
        const velocities = candidates.map((item) => item.viewVelocity);
        const engagements = candidates.map((item) => item.engagement);
        const ages = candidates.map((item) => item.publishedAt ? Date.parse(item.publishedAt) : 0);
        candidates.forEach((item) => {
            item.scoreComponents = {
                viewVelocityPercentile: percentile(velocities, item.viewVelocity),
                engagementPercentile: percentile(engagements, item.engagement),
                recencyPercentile: percentile(ages, item.publishedAt ? Date.parse(item.publishedAt) : 0),
                nicheRelevance: item.nicheRelevance,
            };
            item.trendScore =
                0.47 * item.scoreComponents.viewVelocityPercentile +
                0.20 * item.scoreComponents.engagementPercentile +
                0.20 * item.scoreComponents.recencyPercentile +
                0.13 * item.scoreComponents.nicheRelevance;
        });
        candidates.sort((a, b) => b.trendScore - a.trendScore);
        return {
            schemaVersion: 1,
            generatedAt: nowIso(),
            source: "yt-dlp public YouTube metadata",
            query: board.trend.query,
            maxAgeDays: board.trend.maxAgeDays,
            formula: "available-signal normalized trend score; channelOutlier remains null until channel history is available",
            candidates,
            extractedPatterns: this.extractPatterns(candidates.slice(0, 5)),
        };
    }

    extractPatterns(candidates) {
        return candidates.map((item) => ({
            videoId: item.id,
            titlePromise: item.title,
            durationSeconds: item.durationSeconds,
            titlePatterns: {
                question: /\?/.test(item.title),
                numberLed: /^\s*\d+/.test(item.title),
                resultLanguage: /how|result|build|made|from|to|best|why/i.test(item.title),
            },
            evidenceLimits: "Public metadata only; competitor retention and private analytics are unavailable.",
        }));
    }
}

module.exports = { TrendScout, percentile, relevance };
