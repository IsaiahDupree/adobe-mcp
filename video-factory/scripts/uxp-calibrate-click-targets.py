#!/usr/bin/env python3
"""Detect and optionally click UXP Developer Tools row actions from screenshots.

This tool treats the screenshot as the source of truth for button placement. It
does not call provider APIs, publish anything, or load plugins through the UXP
CLI. Optional clicks use a local macOS click backend against the visible UXP UI.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image


DEFAULT_WINDOW_BOUNDS_TIMEOUT_MS = 750
DEFAULT_CLICK_TIMEOUT_MS = 500
DEFAULT_ACTION_ZONE_FROM_RIGHT = 560
DEFAULT_ACTION_ZONE_RIGHT_PAD = 20


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("value must be >= 0")
    return parsed


def run(command: list[str], timeout_ms: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=True,
        timeout=max(timeout_ms, 1) / 1000,
    )


def parse_bounds(raw: str) -> dict[str, int]:
    values = [int(float(part.strip())) for part in raw.split(",")]
    if len(values) != 4:
        raise ValueError("window bounds must be x,y,width,height")
    x, y, width, height = values
    return {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "right": x + width,
        "bottom": y + height,
    }


def read_window_bounds(timeout_ms: int) -> dict[str, int]:
    script = """
tell application "System Events"
  tell process "Adobe UXP Developer Tools"
    set frontmost to true
    set p to position of window 1
    set s to size of window 1
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell
"""
    output = run(["/usr/bin/osascript", "-e", script], timeout_ms).stdout.strip()
    bounds = parse_bounds(output)
    bounds["source"] = "system-events"
    return bounds


def capture_screenshot(path: Path, timeout_ms: int = 3000) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    run(["/usr/sbin/screencapture", "-x", str(path)], timeout_ms)
    return path


def foreground_clusters(
    image: Image.Image,
    *,
    row_y: int,
    x0: int,
    x1: int,
    half_height: int,
    merge_gap: int,
    min_width: int,
    min_peak: float,
) -> list[dict[str, int | float]]:
    rgb = np.asarray(image.convert("RGB"))
    height, width, _ = rgb.shape
    crop_y0 = max(0, row_y - half_height)
    crop_y1 = min(height, row_y + half_height + 1)
    crop_x0 = max(0, x0)
    crop_x1 = min(width, x1)
    crop = rgb[crop_y0:crop_y1, crop_x0:crop_x1]
    if crop.size == 0:
        return []

    gray = crop.mean(axis=2)
    mask = gray < 170
    column_score = mask.sum(axis=0).astype(float)
    if len(column_score) >= 5:
        column_score = np.convolve(column_score, np.ones(5) / 5, mode="same")

    raw: list[tuple[int, int, float]] = []
    in_cluster = False
    start = 0
    for index, value in enumerate(column_score):
        if value > min_peak and not in_cluster:
            start = index
            in_cluster = True
        if in_cluster and (value <= min_peak or index == len(column_score) - 1):
            end = index
            peak = float(column_score[start : max(start + 1, end)].max())
            if end - start >= min_width:
                raw.append((crop_x0 + start, crop_x0 + end, peak))
            in_cluster = False

    merged: list[tuple[int, int, float]] = []
    for cluster in raw:
        if merged and cluster[0] - merged[-1][1] < merge_gap:
            merged[-1] = (merged[-1][0], cluster[1], max(merged[-1][2], cluster[2]))
        else:
            merged.append(cluster)

    return [
        {
            "x0": left,
            "x1": right,
            "centerX": round((left + right) / 2),
            "width": right - left,
            "peak": round(peak, 3),
        }
        for left, right, peak in merged
    ]


def label_clusters(clusters: list[dict[str, int | float]]) -> tuple[str, list[dict[str, int | float | str]]]:
    real = [item for item in clusters if int(item["width"]) >= 12]
    state = "unknown"
    labels: list[str] = []
    if len(clusters) >= 5 and len(real) >= 4:
        state = "loaded"
        labels = ["debug", "reload", "watch", "unload", "more"]
    elif len(real) >= 2:
        state = "not-loaded"
        labels = ["load", "load-watch", "more"]

    labeled = []
    for index, item in enumerate(clusters):
        label = labels[index] if index < len(labels) else f"cluster-{index + 1}"
        labeled.append({**item, "label": label})
    return state, labeled


def detect_targets(
    screenshot: Path,
    *,
    window: dict[str, int],
    row_index: int,
    y_from_top: int,
    row_height: int,
    half_height: int,
    action_zone_from_right: int,
    action_zone_right_pad: int,
    merge_gap: int,
    min_width: int,
    min_peak: float,
) -> dict[str, object]:
    image = Image.open(screenshot)
    row_y = int(window["y"] + y_from_top + (row_index - 1) * row_height)
    action_x0 = int(window["right"] - action_zone_from_right)
    action_x1 = int(window["right"] - action_zone_right_pad)
    clusters = foreground_clusters(
        image,
        row_y=row_y,
        x0=action_x0,
        x1=action_x1,
        half_height=half_height,
        merge_gap=merge_gap,
        min_width=min_width,
        min_peak=min_peak,
    )
    state, labeled = label_clusters(clusters)
    for item in labeled:
        item["centerY"] = row_y
        item["xFromRight"] = int(window["right"] - int(item["centerX"]))
        item["yFromTop"] = int(row_y - window["y"] - (row_index - 1) * row_height)

    targets = {str(item["label"]): item for item in labeled}
    return {
        "screenshot": str(screenshot),
        "window": window,
        "row": {
            "rowIndex": row_index,
            "centerY": row_y,
            "yFromTop": y_from_top,
            "rowHeight": row_height,
        },
        "actionZone": {
            "x0": action_x0,
            "x1": action_x1,
            "fromRight": action_zone_from_right,
            "rightPad": action_zone_right_pad,
        },
        "stateGuess": state,
        "clusters": labeled,
        "targets": targets,
    }


def click_target(target: dict[str, int | float | str], backend: str, timeout_ms: int) -> dict[str, object]:
    x = int(target["centerX"])
    y = int(target["centerY"])
    started = time.perf_counter()
    if backend == "cliclick":
        binary = os.environ.get("CLICKLICK_BIN", "/opt/homebrew/bin/cliclick")
        run([binary, f"c:{x},{y}"], timeout_ms)
    else:
        raise ValueError(f"unsupported backend: {backend}")
    return {
        "backend": backend,
        "x": x,
        "y": y,
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--screenshot", type=Path, help="Existing screenshot to analyze.")
    parser.add_argument("--capture", action="store_true", help="Capture a fresh screenshot before detection.")
    parser.add_argument("--evidence-dir", type=Path, default=Path("/tmp/uxp-click-calibration"))
    parser.add_argument("--output", type=Path, help="Write JSON calibration output.")
    parser.add_argument("--window-bounds", help="Known UXP window bounds as x,y,width,height.")
    parser.add_argument("--window-bounds-timeout-ms", type=positive_int, default=DEFAULT_WINDOW_BOUNDS_TIMEOUT_MS)
    parser.add_argument("--row-index", type=positive_int, default=1)
    parser.add_argument("--y-from-top", type=positive_int, default=203)
    parser.add_argument("--row-height", type=positive_int, default=33)
    parser.add_argument("--half-height", type=positive_int, default=12)
    parser.add_argument("--action-zone-from-right", type=positive_int, default=DEFAULT_ACTION_ZONE_FROM_RIGHT)
    parser.add_argument("--action-zone-right-pad", type=positive_int, default=DEFAULT_ACTION_ZONE_RIGHT_PAD)
    parser.add_argument("--merge-gap", type=positive_int, default=18)
    parser.add_argument("--min-width", type=positive_int, default=3)
    parser.add_argument("--min-peak", type=float, default=1.0)
    parser.add_argument("--click", choices=["load", "load-watch", "unload", "watch", "reload", "debug", "more"])
    parser.add_argument("--click-backend", choices=["cliclick"], default="cliclick")
    parser.add_argument("--click-timeout-ms", type=positive_int, default=DEFAULT_CLICK_TIMEOUT_MS)
    parser.add_argument("--settle-ms", type=positive_int, default=0)
    parser.add_argument("--after-screenshot", action="store_true", help="Capture an after-click screenshot.")
    args = parser.parse_args()

    started = time.perf_counter()
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    screenshot = args.screenshot
    if args.capture or screenshot is None:
        screenshot = args.evidence_dir / f"uxp-calibration-before-{int(time.time() * 1000)}.png"
        capture_screenshot(screenshot)

    if args.window_bounds:
        window = parse_bounds(args.window_bounds)
        window["source"] = "argument"
    else:
        window = read_window_bounds(args.window_bounds_timeout_ms)

    result = detect_targets(
        screenshot,
        window=window,
        row_index=max(1, args.row_index),
        y_from_top=args.y_from_top,
        row_height=max(1, args.row_height),
        half_height=args.half_height,
        action_zone_from_right=args.action_zone_from_right,
        action_zone_right_pad=args.action_zone_right_pad,
        merge_gap=args.merge_gap,
        min_width=args.min_width,
        min_peak=args.min_peak,
    )

    if args.click:
        target = result["targets"].get(args.click)  # type: ignore[index,union-attr]
        if not target:
            result["click"] = {
                "status": "NOT_FOUND",
                "button": args.click,
                "availableTargets": sorted(result["targets"].keys()),  # type: ignore[union-attr]
            }
            result["status"] = "NEEDS_ATTENTION"
        else:
            result["click"] = {
                "status": "CLICKED",
                "button": args.click,
                **click_target(target, args.click_backend, args.click_timeout_ms),
            }
            if args.settle_ms:
                time.sleep(args.settle_ms / 1000)
            if args.after_screenshot:
                after = args.evidence_dir / f"uxp-calibration-after-{args.click}-{int(time.time() * 1000)}.png"
                capture_screenshot(after)
                result["afterScreenshot"] = str(after)
            result["status"] = "CLICK_RECORDED"
    else:
        result["status"] = "DETECTED"

    result["durationMs"] = round((time.perf_counter() - started) * 1000, 3)
    output = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(f"{output}\n", encoding="utf-8")
    print(output)
    return 0 if result["status"] != "NEEDS_ATTENTION" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.TimeoutExpired as error:
        print(json.dumps({
            "status": "NEEDS_ATTENTION",
            "error": {
                "code": "UXP_CALIBRATION_TIMEOUT",
                "message": f"Timed out running {' '.join(error.cmd)}",
            },
        }, indent=2), file=sys.stderr)
        raise SystemExit(2)
    except Exception as error:
        print(json.dumps({
            "status": "NEEDS_ATTENTION",
            "error": {
                "code": "UXP_CALIBRATION_FAILED",
                "message": str(error),
            },
        }, indent=2), file=sys.stderr)
        raise SystemExit(2)
