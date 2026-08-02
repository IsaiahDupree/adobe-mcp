const { nowIso, writeJsonAtomic } = require("./util");

const FORMAT_DIMENSIONS = {
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
    "1:1": { width: 1080, height: 1080 },
};

function formatDimensions(format, resolution) {
    const high = resolution === "4k" ? 2160 : resolution === "1080p" ? 1080 : 720;
    if (format === "9:16") return { width: high, height: Math.round(high * 16 / 9) };
    if (format === "1:1") return { width: high, height: high };
    return { width: Math.round(high * 16 / 9), height: high };
}

function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function paddedFace(face, padding) {
    return {
        left: Math.max(0, face.cx - face.width / 2 - padding),
        top: Math.max(0, face.cy - face.height / 2 - padding),
        right: Math.min(1, face.cx + face.width / 2 + padding),
        bottom: Math.min(1, face.cy + face.height / 2 + padding),
    };
}

function carveFaceSafeBounds(format, regionName, originalBounds, faces, padding) {
    const bounds = { ...originalBounds };
    const margin = 0.015;
    if (!faces.length) return { bounds, safe: true, adjustment: "none-no-face" };
    const exclusions = faces.map((face) => paddedFace(face, padding));
    if (regionName === "left_center") {
        bounds.right = Math.min(bounds.right, ...exclusions.map((box) => box.left - margin));
    } else if (regionName === "right_center") {
        bounds.left = Math.max(bounds.left, ...exclusions.map((box) => box.right + margin));
    } else if (regionName === "top_center") {
        bounds.bottom = Math.min(bounds.bottom, ...exclusions.map((box) => box.top - margin));
    } else if (regionName === "lower_center") {
        bounds.top = Math.max(bounds.top, ...exclusions.map((box) => box.bottom + margin));
    }
    const minimumWidth = format === "9:16" ? 0.34 : 0.18;
    const minimumHeight = 0.12;
    const safe = bounds.right - bounds.left >= minimumWidth && bounds.bottom - bounds.top >= minimumHeight &&
        exclusions.every((box) => !intersects(bounds, box));
    return { bounds, safe, adjustment: safe ? "carved-around-observed-face-track" : "no-safe-foreground-region" };
}

const FALLBACK_REGIONS = {
    "16:9": {
        left_center: { left: 0.05, top: 0.18, right: 0.45, bottom: 0.75 },
        right_center: { left: 0.55, top: 0.18, right: 0.95, bottom: 0.75 },
    },
    "9:16": {
        top_center: { left: 0.08, top: 0.08, right: 0.92, bottom: 0.34 },
        lower_center: { left: 0.08, top: 0.48, right: 0.92, bottom: 0.72 },
    },
    "1:1": {
        left_center: { left: 0.06, top: 0.18, right: 0.46, bottom: 0.72 },
        right_center: { left: 0.54, top: 0.18, right: 0.94, bottom: 0.72 },
    },
};

function average(values, fallback = 0) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function smooth(values, alpha, deadband) {
    const output = [];
    let previous = null;
    for (const value of values) {
        if (previous === null) previous = value;
        else if (Math.abs(value - previous) > deadband) previous = previous + alpha * (value - previous);
        output.push(previous);
    }
    return output;
}

function captionSafeZone(format) {
    return format === "9:16"
        ? { left: 0.04, top: 0.74, right: 0.96, bottom: 0.91, platformUiBottom: 0.94 }
        : { left: 0.08, top: 0.76, right: 0.92, bottom: 0.94, platformUiBottom: 0.97 };
}

class ResponsiveLayoutEngine {
    sceneSubject(subjectTrack, sceneId) {
        return subjectTrack.scenes.find((scene) => scene.scene_id === sceneId) || { samples: [] };
    }

    chooseRegion(format, samples, faceCenterX, facePadding) {
        const scores = new Map();
        for (const sample of samples) {
            for (const region of sample.free_regions || []) {
                if (format === "9:16" && !["top_center", "lower_center"].includes(region.region)) continue;
                if (format !== "9:16" && !["left_center", "right_center"].includes(region.region)) continue;
                const entry = scores.get(region.region) || { total: 0, count: 0, bounds: region.bounds };
                entry.total += region.score;
                entry.count += 1;
                scores.set(region.region, entry);
            }
        }
        const ranked = [...scores.entries()].map(([region, value]) => ({
            region,
            score: value.total / value.count,
            bounds: value.bounds,
        })).sort((a, b) => b.score - a.score);
        const faces = samples.map((sample) => sample.face).filter(Boolean);
        const faceSafe = ranked.find((candidate) =>
            faces.every((face) => !intersects(candidate.bounds, paddedFace(face, facePadding)))
        );
        if (faceSafe) return faceSafe;
        const fallbackName = format === "9:16"
            ? (faceCenterX === null ? "lower_center" : "lower_center")
            : (faceCenterX !== null && faceCenterX > 0.5 ? "left_center" : "right_center");
        return { region: fallbackName, score: 0.5, bounds: FALLBACK_REGIONS[format][fallbackName] };
    }

    cameraPlan(job, format, scene, detectedFaces) {
        const confidence = average(detectedFaces.map((face) => face.confidence));
        const faceHeights = detectedFaces.map((face) => face.height);
        const centersX = smooth(detectedFaces.map((face) => face.cx), job.composition.layout.smoothingAlpha, job.composition.layout.deadband);
        const centersY = smooth(detectedFaces.map((face) => face.cy), job.composition.layout.smoothingAlpha, job.composition.layout.deadband);
        const movement = centersX.length > 1
            ? Math.max(...centersX.slice(1).map((value, index) => Math.hypot(value - centersX[index], centersY[index + 1] - centersY[index])))
            : 0;
        const faceHeight = average(faceHeights);
        const minimum = job.composition.subjectAnalysis.minimumFaceConfidence;
        let enabled = confidence >= minimum && faceHeight >= 0.07 && faceHeight <= 0.34 && movement <= 0.12;
        let reason = null;
        if (!detectedFaces.length) reason = "no-face-detected";
        else if (confidence < minimum) reason = "low-detection-confidence";
        else if (faceHeight > 0.34) reason = "face-already-tight";
        else if (movement > 0.12) reason = "rapid-subject-movement";
        if (scene.animation_grammar === "clean_aroll" || scene.semantic_intent === "emotional_moment") {
            enabled = false;
            reason = "taste-rule-clean-face-focus";
        }
        const targetFaceHeight = format === "9:16" ? 0.18 : 0.2;
        const desiredScale = enabled
            ? Math.min(job.composition.layout.maxZoom, Math.max(1.04, targetFaceHeight / faceHeight))
            : 1;
        const faceCx = centersX.length ? centersX.at(-1) : 0.5;
        const faceCy = centersY.length ? centersY.at(-1) : (format === "9:16" ? 0.32 : 0.4);
        const target = format === "9:16"
            ? { x: 0.5, y: 0.34 }
            : { x: faceCx > 0.5 ? 0.68 : 0.32, y: 0.42 };
        return {
            enabled,
            reason,
            method: "smoothed-face-anchor",
            confidence: Number(confidence.toFixed(4)),
            detectedFaceHeight: Number(faceHeight.toFixed(4)),
            maximumObservedMotion: Number(movement.toFixed(4)),
            scale: Number(desiredScale.toFixed(4)),
            translation: {
                x: Number((target.x - faceCx).toFixed(4)),
                y: Number((target.y - faceCy).toFixed(4)),
            },
            targetAnchor: target,
            phases: [
                { phase: "context", start: scene.start, end: scene.start + scene.animation.intro_seconds, scale: 1 },
                { phase: "focus", start: scene.start + scene.animation.intro_seconds, end: scene.end - scene.animation.outro_seconds, scale: Number(desiredScale.toFixed(4)) },
                { phase: "resolution", start: scene.end - scene.animation.outro_seconds, end: scene.end, scale: 1 },
            ],
        };
    }

    build(job, visualPlan, subjectTrack, retentionPlan) {
        if (!job.composition?.enabled) return { enabled: false, variants: [] };
        const variants = [];
        for (const format of job.composition.formats) {
            const scenes = visualPlan.scenes.map((planned) => {
                const timed = retentionPlan.scenes.find((scene) => scene.sceneId === planned.scene_id);
                const scene = {
                    ...planned,
                    start: timed?.start ?? planned.start,
                    end: timed?.end ?? planned.end,
                };
                const subject = this.sceneSubject(subjectTrack, planned.scene_id);
                const validFaces = subject.samples.map((sample) => sample.face)
                    .filter((face) => face && face.confidence >= job.composition.subjectAnalysis.minimumFaceConfidence);
                const faceCenterX = validFaces.length ? average(validFaces.map((face) => face.cx)) : null;
                const region = this.chooseRegion(
                    format,
                    subject.samples,
                    faceCenterX,
                    job.composition.layout.facePadding
                );
                const safeZone = captionSafeZone(format);
                const carved = carveFaceSafeBounds(
                    format,
                    region.region,
                    region.bounds,
                    validFaces,
                    job.composition.layout.facePadding
                );
                const bounds = carved.bounds;
                if (bounds.bottom > safeZone.top) bounds.bottom = Math.max(bounds.top + 0.12, safeZone.top - 0.03);
                const treatment = carved.safe ? planned.asset_request : null;
                return {
                    sceneId: planned.scene_id,
                    start: scene.start,
                    end: scene.end,
                    semanticIntent: planned.semantic_intent,
                    grammar: treatment ? planned.animation_grammar : "clean_aroll",
                    treatment,
                    subjectDetectionRate: subject.face_detection_rate || 0,
                    subjectSide: faceCenterX === null ? "unknown" : (faceCenterX > 0.5 ? "right" : "left"),
                    graphicRegion: {
                        name: region.region,
                        score: Number(region.score.toFixed(4)),
                        bounds,
                        adjustment: carved.adjustment,
                    },
                    exclusions: {
                        captionSafeZone: safeZone,
                        facePadding: job.composition.layout.facePadding,
                    },
                    camera: this.cameraPlan(job, format, scene, validFaces),
                    animation: planned.animation,
                };
            });
            variants.push({
                format,
                dimensions: formatDimensions(format, job.generation.resolution),
                sequenceName: `MASTER_${format.replace(":", "x")}`,
                scenes,
            });
        }
        const manifest = {
            schemaVersion: 1,
            generatedAt: nowIso(),
            jobId: job.id,
            coordinateSpace: "normalized-0-to-1",
            smoothing: {
                alpha: job.composition.layout.smoothingAlpha,
                deadband: job.composition.layout.deadband,
                maxZoom: job.composition.layout.maxZoom,
            },
            variants,
        };
        writeJsonAtomic(job.outputPaths.responsiveLayout, manifest);
        return manifest;
    }
}

module.exports = {
    FORMAT_DIMENSIONS,
    ResponsiveLayoutEngine,
    captionSafeZone,
    carveFaceSafeBounds,
    formatDimensions,
    smooth,
};
