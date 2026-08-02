#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


REGIONS = {
    "left_center": (0.04, 0.18, 0.46, 0.78),
    "right_center": (0.54, 0.18, 0.96, 0.78),
    "top_center": (0.18, 0.05, 0.82, 0.35),
    "lower_center": (0.16, 0.58, 0.84, 0.86),
}


def clamp(value, minimum=0.0, maximum=1.0):
    return max(minimum, min(maximum, float(value)))


def overlap(a, b):
    left = max(a[0], b[0])
    top = max(a[1], b[1])
    right = min(a[2], b[2])
    bottom = min(a[3], b[3])
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    area = max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))
    return intersection / area


def region_metrics(frame, box, exclusions):
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box
    crop = frame[int(y1 * height):max(int(y1 * height) + 1, int(y2 * height)),
                 int(x1 * width):max(int(x1 * width) + 1, int(x2 * width))]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.size else np.zeros((1, 1), dtype=np.uint8)
    brightness = float(np.mean(gray) / 255.0)
    complexity = clamp(float(np.std(gray) / 80.0))
    exclusion_penalty = max([overlap(box, item) for item in exclusions] or [0.0])
    score = clamp(0.72 * (1.0 - complexity) + 0.28 * (1.0 - exclusion_penalty))
    return score, brightness, complexity


def face_confidence(weight, face, frame_width, frame_height):
    relative_area = (face[2] * face[3]) / max(1.0, frame_width * frame_height)
    detector_signal = 1.0 / (1.0 + math.exp(-float(weight))) if weight is not None else 0.5
    return clamp(0.55 * detector_signal + 0.45 * min(1.0, relative_area / 0.04))


def analyze_frame(frame, time_seconds, detector, previous_histogram):
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces, _, weights = detector.detectMultiScale3(
        gray,
        scaleFactor=1.08,
        minNeighbors=4,
        minSize=(max(24, width // 30), max(24, height // 30)),
        outputRejectLevels=True,
    )
    face_data = None
    torso = None
    exclusions = []
    if len(faces):
        index = int(np.argmax([w * h for _, _, w, h in faces]))
        x, y, w, h = [int(value) for value in faces[index]]
        confidence = face_confidence(weights[index] if len(weights) > index else None, faces[index], width, height)
        face_data = {
            "cx": clamp((x + w / 2) / width),
            "cy": clamp((y + h / 2) / height),
            "width": clamp(w / width),
            "height": clamp(h / height),
            "confidence": round(confidence, 4),
            "method": "opencv-haar-frontal-face",
        }
        face_box = (x / width, y / height, (x + w) / width, (y + h) / height)
        exclusions.append(face_box)
        torso_box = (
            clamp(face_data["cx"] - face_data["width"] * 1.35),
            clamp(face_data["cy"] + face_data["height"] * 0.25),
            clamp(face_data["cx"] + face_data["width"] * 1.35),
            1.0,
        )
        torso = {
            "left": round(torso_box[0], 4),
            "right": round(torso_box[2], 4),
            "top": round(torso_box[1], 4),
            "bottom": 1.0,
            "confidence": round(confidence * 0.62, 4),
            "method": "face-projected-estimate",
        }
        exclusions.append(torso_box)

    histogram = cv2.calcHist([gray], [0], None, [32], [0, 256])
    cv2.normalize(histogram, histogram)
    shot_delta = 0.0 if previous_histogram is None else 1.0 - float(cv2.compareHist(previous_histogram, histogram, cv2.HISTCMP_CORREL))
    free_regions = []
    for name, box in REGIONS.items():
        score, brightness, complexity = region_metrics(frame, box, exclusions)
        free_regions.append({
            "region": name,
            "score": round(score, 4),
            "brightness": round(brightness, 4),
            "complexity": round(complexity, 4),
            "bounds": {"left": box[0], "top": box[1], "right": box[2], "bottom": box[3]},
        })
    free_regions.sort(key=lambda item: item["score"], reverse=True)
    return {
        "time": round(float(time_seconds), 3),
        "face": face_data,
        "torso": torso,
        "hands": [],
        "person_segmentation": {"status": "not_requested", "mask_path": None},
        "free_regions": free_regions,
        "background": {
            "brightness": round(float(np.mean(gray) / 255.0), 4),
            "complexity": round(clamp(float(np.std(gray) / 80.0)), 4),
        },
        "shot_change_score": round(clamp(shot_delta), 4),
    }, histogram


def sample_scene(scene, detector, interval):
    source = Path(scene["source"])
    if not source.exists():
        raise FileNotFoundError(f"Subject-analysis source not found: {source}")
    capture = cv2.VideoCapture(str(source))
    frames = []
    previous_histogram = None
    if capture.isOpened() and capture.get(cv2.CAP_PROP_FRAME_COUNT) > 1:
        fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
        frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        duration = float(scene.get("durationSeconds") or frame_count / fps)
        time_value = 0.0
        while time_value < max(0.01, duration):
            capture.set(cv2.CAP_PROP_POS_MSEC, time_value * 1000.0)
            ok, frame = capture.read()
            if ok:
                analyzed, previous_histogram = analyze_frame(frame, time_value, detector, previous_histogram)
                frames.append(analyzed)
            time_value += interval
        capture.release()
    else:
        capture.release()
        frame = cv2.imread(str(source))
        if frame is None:
            raise ValueError(f"OpenCV could not decode subject-analysis source: {source}")
        analyzed, _ = analyze_frame(frame, 0.0, detector, None)
        frames.append(analyzed)
    detected = [item for item in frames if item["face"] is not None]
    return {
        "scene_id": scene["sceneId"],
        "source": str(source),
        "sample_count": len(frames),
        "face_detection_rate": round(len(detected) / max(1, len(frames)), 4),
        "samples": frames,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.loads(Path(args.input).read_text())
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if detector.empty():
        raise RuntimeError("OpenCV frontal-face cascade is unavailable")
    scenes = [sample_scene(scene, detector, float(payload.get("sampleIntervalSeconds", 1.0))) for scene in payload["scenes"]]
    output = {
        "schemaVersion": 1,
        "provider": "opencv-haar-frontal-face",
        "coordinateSpace": "normalized-0-to-1",
        "sampleIntervalSeconds": payload.get("sampleIntervalSeconds", 1.0),
        "scenes": scenes,
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(output, indent=2) + "\n")


if __name__ == "__main__":
    main()
