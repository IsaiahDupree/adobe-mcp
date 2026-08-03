#!/usr/bin/env python3
"""Measure a local short-form creator benchmark corpus without redistributing media."""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import subprocess
from pathlib import Path

import cv2
import numpy as np


def run_json(command: list[str]) -> dict:
    return json.loads(subprocess.check_output(command, text=True))


def probe_media(path: Path) -> dict:
    payload = run_json([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ])
    video = next(stream for stream in payload["streams"] if stream["codec_type"] == "video")
    audio = next((stream for stream in payload["streams"] if stream["codec_type"] == "audio"), None)
    rate_parts = video.get("avg_frame_rate", "0/1").split("/")
    frame_rate = float(rate_parts[0]) / max(1.0, float(rate_parts[1]))
    return {
        "durationSeconds": round(float(payload["format"]["duration"]), 3),
        "width": int(video["width"]),
        "height": int(video["height"]),
        "frameRate": round(frame_rate, 3),
        "videoCodec": video.get("codec_name"),
        "audioCodec": audio.get("codec_name") if audio else None,
        "audioSampleRate": int(audio["sample_rate"]) if audio and audio.get("sample_rate") else None,
        "fileSizeBytes": int(payload["format"].get("size", 0)),
    }


def audio_metrics(path: Path) -> dict:
    process = subprocess.run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-af", "ebur128=peak=true,silencedetect=noise=-35dB:d=0.25", "-f", "null", "-"
    ], capture_output=True, text=True)
    output = process.stderr
    integrated = re.findall(r"\bI:\s*(-?[0-9.]+) LUFS", output)
    true_peak = re.findall(r"\bPeak:\s*(-?[0-9.]+) dBFS", output)
    silences = [float(value) for value in re.findall(r"silence_duration: ([0-9.]+)", output)]
    return {
        "integratedLufs": float(integrated[-1]) if integrated else None,
        "truePeakDbfs": float(true_peak[-1]) if true_peak else None,
        "silenceEventCount": len(silences),
        "silenceSeconds": round(sum(silences), 3),
        "longestSilenceSeconds": round(max(silences, default=0), 3),
    }


def transcript_metrics(path: Path, duration: float) -> dict:
    if not path.exists():
        return {"available": False}
    payload = json.loads(path.read_text())
    segments = payload.get("segments", [])
    words = [word for segment in segments for word in segment.get("words", []) if word.get("word", "").strip()]
    text = " ".join(segment.get("text", "").strip() for segment in segments).strip()
    word_count = len(re.findall(r"[A-Za-z0-9']+", text))
    hook_words = [word["word"].strip() for word in words if float(word.get("start", 99)) < 3.0]
    closing = [word["word"].strip() for word in words if float(word.get("start", 0)) >= max(0, duration - 8)]
    pauses = []
    for previous, current in zip(words, words[1:]):
        gap = float(current.get("start", 0)) - float(previous.get("end", 0))
        if gap >= 0.25:
            pauses.append(gap)
    spoken_span = max(0.001, (float(words[-1]["end"]) - float(words[0]["start"]))) if words else duration
    return {
        "available": True,
        "text": text,
        "wordCount": word_count,
        "wordsPerMinute": round(word_count / max(duration, 0.001) * 60, 1),
        "activeSpeechWordsPerMinute": round(word_count / spoken_span * 60, 1),
        "segmentCount": len(segments),
        "averageSegmentSeconds": round(statistics.mean([
            float(segment["end"]) - float(segment["start"]) for segment in segments
        ]), 3) if segments else 0,
        "hookFirstThreeSeconds": " ".join(hook_words),
        "openingSegment": segments[0].get("text", "").strip() if segments else "",
        "closingEightSeconds": " ".join(closing),
        "pauseCountOver250ms": len(pauses),
        "averagePauseSeconds": round(statistics.mean(pauses), 3) if pauses else 0,
        "longestPauseSeconds": round(max(pauses, default=0), 3),
    }


def robust_threshold(values: list[float]) -> float:
    if not values:
        return 1.0
    median = statistics.median(values)
    deviations = [abs(value - median) for value in values]
    mad = statistics.median(deviations) or 0.001
    percentile = float(np.percentile(values, 92))
    return max(0.015, min(0.42, max(median + 4.5 * mad, percentile)))


def visual_metrics(path: Path, output_sheet: Path, duration: float) -> dict:
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    sample_stride = max(1, round(fps / 6))
    face_stride = max(1, round(fps / 2))
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    differences: list[tuple[float, float]] = []
    face_samples = []
    edge_regions = {"top": [], "middle": [], "bottom": []}
    previous = None
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % sample_stride == 0:
            small = cv2.resize(frame, (160, 284))
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            if previous is not None:
                difference = float(np.mean(cv2.absdiff(gray, previous)) / 255.0)
                differences.append((frame_index / fps, difference))
            previous = gray
        if frame_index % face_stride == 0:
            gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            scale = 480 / max(frame.shape[1], 1)
            detect = cv2.resize(gray_frame, (480, round(frame.shape[0] * scale)))
            faces = cascade.detectMultiScale(detect, scaleFactor=1.12, minNeighbors=5, minSize=(42, 42))
            if len(faces):
                x, y, width, height = max(faces, key=lambda item: item[2] * item[3])
                face_samples.append({
                    "present": True,
                    "x": (x + width / 2) / detect.shape[1],
                    "y": (y + height / 2) / detect.shape[0],
                    "area": (width * height) / (detect.shape[0] * detect.shape[1]),
                    "count": len(faces),
                })
            else:
                face_samples.append({"present": False, "count": 0})
            edges = cv2.Canny(cv2.resize(gray_frame, (270, 480)), 90, 180)
            for name, start, end in [("top", 0, 160), ("middle", 160, 340), ("bottom", 340, 480)]:
                edge_regions[name].append(float(np.mean(edges[start:end] > 0)))
        frame_index += 1
    capture.release()

    threshold = robust_threshold([score for _, score in differences])
    cuts = []
    for timestamp, score in differences:
        if score >= threshold and (not cuts or timestamp - cuts[-1]["timeSeconds"] >= 0.28):
            cuts.append({"timeSeconds": round(timestamp, 3), "differenceScore": round(score, 4)})
    present = [sample for sample in face_samples if sample["present"]]
    presenter_presence = len(present) / max(1, len(face_samples))
    face_center = {
        "x": round(statistics.median([sample["x"] for sample in present]), 3),
        "y": round(statistics.median([sample["y"] for sample in present]), 3),
    } if present else None
    face_area = round(statistics.median([sample["area"] for sample in present]), 4) if present else None
    make_contact_sheet(path, output_sheet, duration)
    return {
        "sampleRateFps": 6,
        "detectedHardCuts": cuts,
        "detectedHardCutCount": len(cuts),
        "hardCutThreshold": round(threshold, 4),
        "meanSecondsPerDetectedCut": round(duration / max(1, len(cuts) + 1), 3),
        "presenterFacePresenceRatio": round(presenter_presence, 3),
        "nonPresenterVisualProxyRatio": round(1 - presenter_presence, 3),
        "medianFaceCenter": face_center,
        "medianFaceFrameAreaRatio": face_area,
        "multiFaceSampleRatio": round(sum(sample["count"] > 1 for sample in face_samples) / max(1, len(face_samples)), 3),
        "edgeDensityByRegion": {
            name: round(statistics.mean(values), 4) if values else 0 for name, values in edge_regions.items()
        },
        "measurementNote": "Face absence is a B-roll/graphics proxy, not semantic scene classification.",
    }


def make_contact_sheet(path: Path, output: Path, duration: float) -> None:
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frames = []
    for timestamp in np.linspace(0.4, max(0.4, duration - 0.4), 12):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(timestamp * fps))
        ok, frame = capture.read()
        if not ok:
            continue
        frame = cv2.resize(frame, (270, 480))
        cv2.rectangle(frame, (0, 0), (92, 32), (0, 0, 0), -1)
        cv2.putText(frame, f"{timestamp:04.1f}s", (8, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (255, 255, 255), 2)
        frames.append(frame)
    capture.release()
    while len(frames) < 12:
        frames.append(np.zeros((480, 270, 3), dtype=np.uint8))
    rows = [np.hstack(frames[index:index + 4]) for index in range(0, 12, 4)]
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), np.vstack(rows))


def format_family(title: str) -> str:
    lowered = title.lower()
    if " vs" in lowered or "which video" in lowered or "different delivery" in lowered:
        return "comparison-or-test"
    if "rating" in lowered or "types" in lowered or "tools" in lowered or "101" in lowered:
        return "rating-list-or-taxonomy"
    if "hi we" in lowered or "story" in lowered:
        return "story-or-identity"
    return "teaching-demonstration"


def hook_family(title: str, transcript: dict) -> str:
    opening = f"{title} {transcript.get('openingSegment', '')}".lower()
    if "which" in opening or "?" in opening:
        return "question-or-prediction"
    if " vs" in opening or "different" in opening or "more cuts" in opening:
        return "comparison-or-contrast"
    if re.search(r"\b(five|seven|three|top|rating|types|tools|songs)\b", opening):
        return "list-or-taxonomy"
    if "my name" in opening or "we met" in opening:
        return "personal-story"
    return "direct-claim-or-instruction"


def cta_family(transcript: dict) -> str:
    closing = transcript.get("closingEightSeconds", "").lower()
    if "comment" in closing:
        return "keyword-comment"
    if "follow" in closing:
        return "follow"
    return "none-or-implicit"


def summarize(rows: list[dict]) -> dict:
    ranked = [row for row in rows if row["rank"] <= 20]
    def mean(path: tuple[str, ...]) -> float:
        values = []
        for row in ranked:
            value = row
            for key in path:
                value = value.get(key) if isinstance(value, dict) else None
            if isinstance(value, (int, float)) and math.isfinite(value):
                values.append(value)
        return round(statistics.mean(values), 3) if values else 0
    family_performance = {}
    for family in sorted({row["formatFamily"] for row in ranked}):
        group = [row for row in ranked if row["formatFamily"] == family]
        family_performance[family] = {
            "reels": len(group),
            "meanViews": round(statistics.mean(row.get("views", 0) for row in group)),
            "medianViews": round(statistics.median(row.get("views", 0) for row in group)),
            "meanVisibleEngagementRate": round(statistics.mean(
                (row.get("likes", 0) + row.get("comments", 0)) / max(1, row.get("views", 0)) for row in group
            ), 4),
        }
    return {
        "schemaVersion": 1,
        "corpusSize": len(ranked),
        "styleAnchorIncluded": any(row["rank"] > 20 for row in rows),
        "durationSeconds": {
            "mean": mean(("media", "durationSeconds")),
            "median": round(statistics.median(row["media"]["durationSeconds"] for row in ranked), 3),
            "minimum": min(row["media"]["durationSeconds"] for row in ranked),
            "maximum": max(row["media"]["durationSeconds"] for row in ranked),
        },
        "pacing": {
            "meanWordsPerMinute": mean(("transcript", "wordsPerMinute")),
            "medianWordsPerMinute": round(statistics.median(
                row["transcript"]["wordsPerMinute"] for row in ranked if row["transcript"].get("available")
            ), 3),
            "meanSecondsPerDetectedCut": mean(("visual", "meanSecondsPerDetectedCut")),
            "meanDetectedHardCuts": mean(("visual", "detectedHardCutCount")),
            "meanPauseCountOver250ms": mean(("transcript", "pauseCountOver250ms")),
        },
        "composition": {
            "meanPresenterFacePresenceRatio": mean(("visual", "presenterFacePresenceRatio")),
            "meanNonPresenterVisualProxyRatio": mean(("visual", "nonPresenterVisualProxyRatio")),
            "medianFaceCenterX": round(statistics.median([
                row["visual"]["medianFaceCenter"]["x"] for row in ranked if row["visual"]["medianFaceCenter"]
            ]), 3),
            "medianFaceCenterY": round(statistics.median([
                row["visual"]["medianFaceCenter"]["y"] for row in ranked if row["visual"]["medianFaceCenter"]
            ]), 3),
        },
        "audio": {
            "meanIntegratedLufs": mean(("audio", "integratedLufs")),
            "meanTruePeakDbfs": mean(("audio", "truePeakDbfs")),
            "meanSilenceSeconds": mean(("audio", "silenceSeconds")),
        },
        "formatFamilies": {
            family: sum(row["formatFamily"] == family for row in ranked)
            for family in sorted({row["formatFamily"] for row in ranked})
        },
        "formatFamilyPerformance": family_performance,
        "ctaFamilies": {
            family: sum(row["ctaFamily"] == family for row in ranked)
            for family in sorted({row["ctaFamily"] for row in ranked})
        },
        "hookFamilies": {
            family: sum(row["hookFamily"] == family for row in ranked)
            for family in sorted({row["hookFamily"] for row in ranked})
        },
        "methodology": {
            "hardCuts": "Six-frame-per-second robust luminance-difference detector; editorial review still required for subtle jump cuts.",
            "bRoll": "Presenter face absence is reported as a proxy and is not treated as semantic ground truth.",
            "speech": "OpenAI Whisper word timestamps measured from locally acquired public renditions.",
            "audio": "FFmpeg EBU R128 integrated loudness, true peak, and -35 dB silence detection.",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--transcript-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--frames-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for entry in manifest["entries"]:
        source = args.source_dir / entry["file"]
        media = probe_media(source)
        transcript = transcript_metrics(args.transcript_dir / f"{source.stem}.json", media["durationSeconds"])
        visual = visual_metrics(source, args.frames_dir / f"{source.stem}.jpg", media["durationSeconds"])
        row = {
            **entry,
            "formatFamily": format_family(entry["title"]),
            "hookFamily": hook_family(entry["title"], transcript),
            "ctaFamily": cta_family(transcript),
            "media": media,
            "transcript": transcript,
            "visual": visual,
            "audio": audio_metrics(source),
        }
        (args.output_dir / f"{source.stem}.json").write_text(json.dumps(row, indent=2) + "\n")
        rows.append(row)
        print(f"Analyzed {entry['rank']:02d}: {entry['shortcode']}", flush=True)
    aggregate = summarize(rows)
    (args.output_dir / "aggregate.json").write_text(json.dumps(aggregate, indent=2) + "\n")
    (args.output_dir / "corpus.json").write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    main()
