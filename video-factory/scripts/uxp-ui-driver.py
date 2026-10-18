#!/usr/bin/env python3
"""Deterministic UXP Developer Tools UI driver (no AI at runtime). v2

Pixel-locator driver hardened for non-happy paths:
  - Relaunches / unhides / unminimizes the app when needed (bounded polls,
    no fixed sleeps).
  - Normalizes Retina/display scale (capture px -> window points).
  - Workspace sanity check: rejects occluded or wrong-window captures with
    UXP_WINDOW_OBSCURED instead of clicking blind.
  - Row identity by plugin NAME (tesseract OCR of the ID column) with row
    index fallback, so search filters / reordering can't misroute a click.
  - Detects selected rows (checkbox) and clears selection with Escape before
    clicking -- selection swallows button activation in this Electron view.
  - Re-asserts app frontmost immediately before the click (focus-steal race).
  - Toast delta detection: green/red toast that APPEARED after the click is
    recorded; a red failure toast becomes UXP_PLUGIN_LOAD_FAILED even if the
    state pixel check is ambiguous.
  - Single-flight lock (flock) so concurrent API calls serialize instead of
    clicking through each other; busy -> UXP_DRIVER_BUSY.
  - Receipts written on EVERY exit path, including failures.

Calibrated 2026-08-09 via AI-vision loop: action labels are the only reliable
hit targets; Load label center is ~250pt from the window's right edge.

Usage:
  uxp-ui-driver.py inspect [--ocr]
  uxp-ui-driver.py state   (--row N | --plugin-name NAME)
  uxp-ui-driver.py click   (--row N | --plugin-name NAME) --action load|unload|load-watch|watch|reload|debug
Exit codes: 0 ok; 2 action/verify; 3 locator; 4 environment; 5 busy.
"""
import argparse, fcntl, json, os, re, subprocess, sys, tempfile, time
from pathlib import Path

import numpy as np
from PIL import Image

APP = "Adobe UXP Developer Tools"
CLICLICK = "/opt/homebrew/bin/cliclick"
TESSERACT = "/opt/homebrew/bin/tesseract"
LOCK_FILE = "/tmp/uxp-ui-driver.lock"
DARK = 150
MERGE_GAP = 14
BUTTON_GAP = 26
MIN_CLUSTER = 3
ROW_MIN_HEIGHT = 8
REF_W = 2408.0            # calibration window width; zones scale from this
ERR_EXIT = {"UXP_ACTION_NOT_AVAILABLE": 2, "UXP_STATE_VERIFY_TIMEOUT": 2,
            "UXP_PLUGIN_LOAD_FAILED": 2, "UXP_ROW_NOT_FOUND": 3,
            "UXP_WINDOW_OBSCURED": 3, "UXP_WINDOW_NOT_FOUND": 4,
            "UXP_APP_OPEN_FAILED": 4, "UXP_CAPTURE_FAILED": 4,
            "UXP_CLICK_FAILED": 4, "UXP_DRIVER_BUSY": 5}

RECEIPT_DIR = [None]      # set in main; fail() writes receipts here

def now_ms(t0): return int((time.time() - t0) * 1000)

def fail(code, message, t0, extra=None):
    out = {"ok": False, "error": code, "message": message, "elapsed_ms": now_ms(t0)}
    if extra: out.update(extra)
    if RECEIPT_DIR[0]:
        try: (RECEIPT_DIR[0] / "receipt.json").write_text(json.dumps(out, indent=2))
        except OSError: pass
    print(json.dumps(out, indent=2))
    sys.exit(ERR_EXIT.get(code, 4))

def osa(script, timeout=5):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=timeout)

def app_running():
    r = osa(f'tell application "System Events" to (name of processes) contains "{APP}"')
    return r.stdout.strip() == "true"

def focus_and_bounds(t0, allow_launch=True):
    """Activate, unhide, unminimize; return (x, y, w, h). Bounded polls only."""
    if not app_running():
        if not allow_launch:
            fail("UXP_WINDOW_NOT_FOUND", f"{APP} is not running", t0)
        r = subprocess.run(["open", "-a", APP], capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            fail("UXP_APP_OPEN_FAILED", f"open -a failed: {r.stderr.strip()}", t0)
        deadline = time.time() + 10
        while time.time() < deadline:
            if app_running(): break
            time.sleep(0.05)
        else:
            fail("UXP_APP_OPEN_FAILED", "app process never appeared after open -a", t0)
    script = (
        f'tell application "{APP}" to activate\n'
        f'tell application "System Events" to tell process "{APP}"\n'
        "  set visible to true\n"
        "  set frontmost to true\n"
        "  if (count of windows) is 0 then return \"NOWIN\"\n"
        "  try\n"
        '    set value of attribute "AXMinimized" of window 1 to false\n'
        "  end try\n"
        "  set p to position of window 1\n"
        "  set s to size of window 1\n"
        '  return (item 1 of p as string) & "," & (item 2 of p as string) & "," & (item 1 of s as string) & "," & (item 2 of s as string)\n'
        "end tell"
    )
    deadline = time.time() + 8
    while time.time() < deadline:
        r = osa(script, timeout=8)
        txt = r.stdout.strip()
        if r.returncode == 0 and txt and txt != "NOWIN":
            try:
                x, y, w, h = (int(float(v)) for v in txt.split(","))
                if w > 400 and h > 200: return x, y, w, h
            except ValueError: pass
        time.sleep(0.1)
    fail("UXP_WINDOW_NOT_FOUND", "no usable window after activate/relaunch", t0)

def capture(bounds, path, t0):
    x, y, w, h = bounds
    r = subprocess.run(["/usr/sbin/screencapture", "-x", f"-R{x},{y},{w},{h}", str(path)],
                       capture_output=True, timeout=10)
    if r.returncode != 0 or not os.path.exists(path):
        fail("UXP_CAPTURE_FAILED", "screencapture failed", t0)
    img = Image.open(path).convert("RGB")
    scale = img.size[0] / float(w)
    if abs(scale - 1.0) > 0.01:   # Retina: normalize to point space
        img = img.resize((w, h))
        img.save(path)
    return np.array(img)

def sanity_check_workspace(im, bounds):
    """The Developer Workspace always shows the blue 'Add Plugin' button in
    the top-right. Right-anchored, so it survives resize. Its absence means
    the capture is occluded, the wrong window, or the wrong tab."""
    H, W, _ = im.shape
    zone = im[30:85, max(0, W - 300):W - 20].reshape(-1, 3).astype(int)
    blue = ((zone[:, 2] - zone[:, 0] > 40) & (zone[:, 2] - zone[:, 1] > 30) &
            (zone[:, 2] > 150)).sum()
    if blue < 200: return False, f"Add Plugin button not found (blue px={int(blue)})"
    return True, None

def find_rows(im):
    """Plugin rows are the text bands that carry >= 2 action button groups in
    the right-anchored actions area. Header ('Actions' = 1 group), search box
    (0 groups) and toasts are excluded naturally."""
    W = im.shape[1]
    band = np.mean(im[:, 60:W - 30], axis=2)
    dark = (band < DARK).sum(axis=1)
    bands, in_b, start = [], False, 0
    for yy in range(90, min(920, im.shape[0])):
        if dark[yy] > 10 and not in_b: start, in_b = yy, True
        if in_b and dark[yy] <= 10:
            if yy - start >= ROW_MIN_HEIGHT: bands.append((start + yy) // 2)
            in_b = False
    return [yc for yc in bands if len(clusters(im, yc)) >= 2]

def clusters(im, yc):
    W = im.shape[1]
    x0 = max(0, W - 1008)      # actions area is right-anchored (calibrated at 2408w)
    strip = np.mean(im[max(0, yc - 11):yc + 11, x0:W - 10], axis=2)
    mask = (strip < DARK).sum(axis=0)
    raw, in_c, s = [], False, 0
    for i, v in enumerate(mask):
        if v > 0 and not in_c: s, in_c = i, True
        if in_c and (v <= 0 or i == len(mask) - 1):
            if i - s >= MIN_CLUSTER: raw.append([x0 + s, x0 + i])
            in_c = False
    merged = []
    for a, b in raw:
        if merged and a - merged[-1][1] < MERGE_GAP: merged[-1][1] = b
        else: merged.append([a, b])
    buttons = []
    for a, b in merged:
        if buttons and a - buttons[-1][-1][1] < BUTTON_GAP: buttons[-1].append([a, b])
        else: buttons.append([[a, b]])
    out = []
    for grp in buttons:
        span_a, span_b = grp[0][0], grp[-1][1]
        la, lb = grp[-1]
        cx = (la + lb) // 2
        if (span_b - span_a) <= 12 and (W - cx) < 70: continue
        out.append((span_a, span_b, cx))
    return out

def row_state(im, yc):
    """Green state dot is the only saturated green in a plugin row; scan the
    whole row left of the actions area so column drift can't break this."""
    W = im.shape[1]
    x1 = max(120, W - 1020)
    zone = im[yc - 9:yc + 9, 100:x1].reshape(-1, 3).astype(int)
    greens = ((zone[:, 1] - zone[:, 0] > 30) & (zone[:, 1] - zone[:, 2] > 30) &
              (zone[:, 1] > 100)).sum()
    return "loaded" if greens >= 4 else "not_loaded"

def row_selected(im, yc):
    box = im[yc - 7:yc + 7, 59:73].reshape(-1, 3).astype(int)   # checkbox, left-anchored
    dark = (box.mean(axis=1) < 120).sum()
    blue = ((box[:, 2] - box[:, 0] > 60) & (box[:, 2] > 150)).sum()
    return bool(dark > 40 or blue > 30)   # filled checkbox: dark or Adobe blue

def row_name(im, yc, tmpdir):
    """OCR the ID column cell. Returns '' if tesseract unavailable."""
    if not os.path.exists(TESSERACT): return ""
    W = im.shape[1]
    cell = im[yc - 13:yc + 13, 150:min(900, max(300, W - 1020))]
    # Leptonica cannot read through the /tmp and /var symlinks -> realpath,
    # and fall back to /private/tmp if it still refuses the path.
    for base in (os.path.realpath(tmpdir), "/private/tmp"):
        p = Path(base) / f"uxp-ocr-cell-{os.getpid()}-{yc}.png"
        try:
            Image.fromarray(cell).resize((cell.shape[1] * 2, cell.shape[0] * 2)).save(p)
            r = subprocess.run([TESSERACT, str(p), "stdout", "--psm", "7", "-l", "eng"],
                               capture_output=True, timeout=10)
            text = r.stdout.decode("utf-8", errors="replace").strip()
            if text: return text
        except (subprocess.SubprocessError, OSError):
            pass
        finally:
            try: p.unlink(missing_ok=True)
            except OSError: pass
    return ""              # OCR is best-effort; row-index fallback still works

def toast_state(im):
    """(kind, px) for a toast in the bottom band: 'success' | 'failure' | None."""
    H, W, _ = im.shape
    band = im[H - 120:H - 10, W // 4: 3 * W // 4].reshape(-1, 3).astype(int)
    green = ((band[:, 1] - band[:, 0] > 25) & (band[:, 1] - band[:, 2] > 20) &
             (band[:, 1] > 70) & (band[:, 1] < 190)).sum()
    red = ((band[:, 0] - band[:, 1] > 40) & (band[:, 0] - band[:, 2] > 30) &
           (band[:, 0] > 120)).sum()
    if red > 400: return "failure", int(red)
    if green > 400: return "success", int(green)
    return None, 0

def action_map(state, cl):
    if state == "loaded" and len(cl) >= 4:
        return dict(zip(["debug", "reload", "watch", "unload"], cl[-4:]))
    if state == "not_loaded" and len(cl) >= 2:
        return {"load": cl[-2], "load-watch": cl[-1]}
    return {}

def snapshot(bounds, path, t0, tmpdir, ocr=False, retry=True):
    im = capture(bounds, path, t0)
    ok, why = sanity_check_workspace(im, bounds)
    if not ok:
        if retry:                     # re-assert focus once, then re-capture
            focus_and_bounds(t0)
            return snapshot(bounds, path, t0, tmpdir, ocr=ocr, retry=False)
        fail("UXP_WINDOW_OBSCURED", f"capture failed sanity check: {why}", t0)
    rows = []
    for i, yc in enumerate(find_rows(im), 1):
        st = row_state(im, yc)
        cl = clusters(im, yc)
        rows.append({
            "row": i, "y": yc, "state": st, "selected": row_selected(im, yc),
            "name": row_name(im, yc, tmpdir) if ocr else None,
            "actions": {kk: {"x": c, "span": [a, b]} for kk, (a, b, c) in action_map(st, cl).items()},
        })
    return im, rows

def resolve_row(rows, args, im, tmpdir):
    if args.plugin_name:
        want = re.sub(r"[^a-z0-9]", "", args.plugin_name.lower())
        for r in rows:
            if r["name"] is None: r["name"] = row_name(im, r["y"], tmpdir)
            got = re.sub(r"[^a-z0-9]", "", (r["name"] or "").lower())
            if want and want in got: return r
        return None
    if args.row and args.row <= len(rows): return rows[args.row - 1]
    return None

def click_screen(sx, sy, t0):
    # re-assert frontmost immediately before the click (focus-steal race)
    osa(f'tell application "{APP}" to activate')
    r = subprocess.run([CLICLICK, f"c:{sx},{sy}"], capture_output=True, text=True, timeout=5)
    if r.returncode != 0:
        fail("UXP_CLICK_FAILED", f"cliclick failed: {r.stderr.strip()}", t0)

def acquire_lock(timeout_ms, t0):
    fh = open(LOCK_FILE, "w")
    deadline = time.time() + timeout_ms / 1000.0
    while True:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fh
        except OSError:
            if time.time() >= deadline:
                fail("UXP_DRIVER_BUSY", "another uxp-ui-driver invocation holds the lock", t0)
            time.sleep(0.01)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["inspect", "state", "click"])
    ap.add_argument("--row", type=int)
    ap.add_argument("--plugin-name")
    ap.add_argument("--action", choices=["load", "unload", "load-watch", "watch", "reload", "debug"])
    ap.add_argument("--evidence-dir")
    ap.add_argument("--verify-timeout-ms", type=int, default=4000)
    ap.add_argument("--poll-interval-ms", type=int, default=10)
    ap.add_argument("--lock-timeout-ms", type=int, default=6000)
    ap.add_argument("--click-retries", type=int, default=2)
    ap.add_argument("--ocr", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    ev = Path(args.evidence_dir) if args.evidence_dir else Path(tempfile.mkdtemp(prefix="uxp-ui-"))
    ev.mkdir(parents=True, exist_ok=True)
    RECEIPT_DIR[0] = ev
    lock = acquire_lock(args.lock_timeout_ms, t0)  # noqa: F841 held until exit

    with tempfile.TemporaryDirectory() as tmpdir:
        bounds = focus_and_bounds(t0)
        need_ocr = args.ocr or bool(args.plugin_name)
        im, rows = snapshot(bounds, ev / "before.png", t0, tmpdir, ocr=need_ocr)

        if args.mode in ("inspect", "state"):
            sel = rows
            if args.mode == "state":
                r = resolve_row(rows, args, im, tmpdir)
                if not r:
                    fail("UXP_ROW_NOT_FOUND",
                         f"row={args.row} plugin_name={args.plugin_name!r} not found "
                         f"(rows: {[(x['row'], x['name']) for x in rows]})", t0)
                sel = [r]
            out = {"ok": True, "window": list(bounds), "rows": sel,
                   "elapsed_ms": now_ms(t0), "evidence_dir": str(ev)}
            (ev / "receipt.json").write_text(json.dumps(out, indent=2))
            print(json.dumps(out, indent=2)); return

        if not args.action:
            fail("UXP_ACTION_NOT_AVAILABLE", "click mode requires --action", t0)
        row = resolve_row(rows, args, im, tmpdir)
        if not row:
            fail("UXP_ROW_NOT_FOUND",
                 f"row={args.row} plugin_name={args.plugin_name!r} not found "
                 f"(rows: {[(x['row'], x['name']) for x in rows]})", t0)

        # selected row swallows button clicks -> clear selection and recapture
        if row["selected"]:
            osa(f'tell application "{APP}" to activate\n'
                'tell application "System Events" to key code 53')
            im, rows = snapshot(bounds, ev / "before.png", t0, tmpdir, ocr=need_ocr)
            row = resolve_row(rows, args, im, tmpdir) or row

        if args.action not in row["actions"]:
            fail("UXP_ACTION_NOT_AVAILABLE",
                 f"action '{args.action}' not available on row {row['row']} "
                 f"(state={row['state']}; available: {sorted(row['actions'])})", t0,
                 {"row": row, "evidence_dir": str(ev)})

        pre_toast, _ = toast_state(im)
        wx, wy = bounds[0], bounds[1]
        ax = row["actions"][args.action]["x"]
        click_screen(wx + ax, wy + row["y"], t0)
        clicked_at = now_ms(t0)

        expected = {"load": "loaded", "load-watch": "loaded", "unload": "not_loaded"}.get(args.action)
        result = {"ok": True, "action": args.action, "row": row["row"], "row_name": row["name"],
                  "clicked_window_xy": [ax, row["y"]], "clicked_screen_xy": [wx + ax, wy + row["y"]],
                  "state_before": row["state"], "clicked_at_ms": clicked_at,
                  "evidence_dir": str(ev)}

        if expected is None:
            im2 = capture(bounds, ev / "after.png", t0)
            result["verified"] = "CLICK_RECORDED"
            kind, px = toast_state(im2)
            result["toast"] = {"kind": kind if kind != pre_toast else None, "px": px}
        else:
            deadline = time.time() + args.verify_timeout_ms / 1000.0
            state_now, polls, toast_seen = row["state"], 0, None
            attempts, max_attempts = 1, 1 + max(0, args.click_retries)
            # if the click was swallowed (fresh unhide / focus race), re-click
            reclick_at = time.time() + min(0.7, args.verify_timeout_ms / 3000.0)
            while time.time() < deadline:
                im2 = capture(bounds, ev / "after.png", t0)
                polls += 1
                kind, _ = toast_state(im2)
                if kind and kind != pre_toast: toast_seen = kind
                rows2 = find_rows(im2)
                idx = row["row"] - 1
                if idx < len(rows2):
                    state_now = row_state(im2, rows2[idx])
                    if state_now == expected: break
                if toast_seen == "failure": break
                if (toast_seen is None and attempts < max_attempts
                        and time.time() >= reclick_at):
                    # clear any selection our own click may have caused, then re-click
                    if idx < len(rows2) and row_selected(im2, rows2[idx]):
                        osa(f'tell application "{APP}" to activate\n'
                            'tell application "System Events" to key code 53')
                    click_screen(wx + ax, wy + row["y"], t0)
                    attempts += 1
                    reclick_at = time.time() + min(0.7, args.verify_timeout_ms / 3000.0)
                time.sleep(args.poll_interval_ms / 1000.0)
            result.update({"state_after": state_now, "verify_polls": polls,
                           "click_attempts": attempts, "toast": {"kind": toast_seen}})
            if toast_seen == "failure":
                result.update({"ok": False, "error": "UXP_PLUGIN_LOAD_FAILED",
                               "message": "UXP displayed a failure toast after the click"})
            elif state_now != expected:
                result.update({"ok": False, "error": "UXP_STATE_VERIFY_TIMEOUT",
                               "message": f"state stayed '{state_now}', expected '{expected}'"})
            else:
                result["verified"] = "STATE_CONFIRMED"

        result["elapsed_ms"] = now_ms(t0)
        (ev / "receipt.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
        if not result["ok"]: sys.exit(2)

if __name__ == "__main__":
    main()
