#!/usr/bin/env python3
"""E2E non-happy-path suite for uxp-ui-driver.py against the LIVE app.

Scenarios: baseline OCR, name-based lookup, moved window, resized window,
selected-row interference, hidden app, verify-timeout receipt, unknown
plugin, lock busy. Leaves row 2 Loaded and the window restored.
"""
import fcntl, json, subprocess, sys, time
from pathlib import Path

DRIVER = str(Path(__file__).parent / "uxp-ui-driver.py")
APP = "Adobe UXP Developer Tools"
ORIG_POS, ORIG_SIZE = (516, 228), (2408, 984)
EV_ROOT = Path("/Users/isaiahdupree/Documents/Software/marketing-video-foundry/work/premiere-editing/uxp-e2e")
EV_ROOT.mkdir(parents=True, exist_ok=True)
RESULTS = []

def osa(s): return subprocess.run(["osascript", "-e", s], capture_output=True, text=True, timeout=10)

def drv(*args, expect_exit=0):
    r = subprocess.run(["python3", DRIVER, *args], capture_output=True, text=True, timeout=60)
    try: out = json.loads(r.stdout)
    except json.JSONDecodeError: out = {"raw": r.stdout[-400:], "stderr": r.stderr[-400:]}
    return r.returncode, out

def record(name, passed, detail):
    RESULTS.append({"scenario": name, "pass": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL "), name, "-", json.dumps(detail)[:220])

def set_window(pos, size):
    osa(f'tell application "System Events" to tell process "{APP}"\n'
        f'set position of window 1 to {{{pos[0]}, {pos[1]}}}\n'
        f'set size of window 1 to {{{size[0]}, {size[1]}}}\nend tell')

def wait_state(target, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, out = drv("state", "--row", "2")
        if code == 0 and out.get("rows") and out["rows"][0]["state"] == target: return True
        time.sleep(0.15)
    return False

def roundtrip(tag, name_args):
    ev = str(EV_ROOT / tag)
    c1, o1 = drv("click", *name_args, "--action", "unload", "--evidence-dir", ev + "-unload")
    ok1 = c1 == 0 and o1.get("verified") == "STATE_CONFIRMED"
    c2, o2 = drv("click", *name_args, "--action", "load", "--evidence-dir", ev + "-load")
    ok2 = c2 == 0 and o2.get("verified") == "STATE_CONFIRMED"
    return ok1 and ok2, {"unload": o1.get("verified") or o1.get("error"),
                         "load": o2.get("verified") or o2.get("error"),
                         "unload_ms": o1.get("elapsed_ms"), "load_ms": o2.get("elapsed_ms")}

# --- 1. baseline inspect with OCR
code, out = drv("inspect", "--ocr")
names = [r.get("name") for r in out.get("rows", [])]
record("baseline_inspect_ocr",
       code == 0 and len(out.get("rows", [])) == 2 and any("editstudio" in (n or "").replace(".", "").lower() for n in names),
       {"rows": len(out.get("rows", [])), "names": names, "ms": out.get("elapsed_ms")})

# --- 2. name-based state lookup
code, out = drv("state", "--plugin-name", "editstudio")
record("state_by_plugin_name", code == 0 and out.get("rows", [{}])[0].get("state") == "loaded",
       {"state": out.get("rows", [{}])[0].get("state"), "name": out.get("rows", [{}])[0].get("name")})

# --- 3. moved window
set_window((700, 350), ORIG_SIZE)
ok, det = roundtrip("moved", ["--plugin-name", "editstudio"])
record("moved_window_roundtrip", ok, det)
set_window(ORIG_POS, ORIG_SIZE)

# --- 4. resized window
set_window(ORIG_POS, (1800, 800))
ok, det = roundtrip("resized", ["--plugin-name", "editstudio"])
record("resized_window_roundtrip", ok, det)
set_window(ORIG_POS, ORIG_SIZE)

# --- 5. selected-row interference (select row 2 checkbox first)
subprocess.run(["/opt/homebrew/bin/cliclick", "c:582,470"], timeout=5)
time.sleep(0.2)
code, out = drv("click", "--row", "2", "--action", "unload", "--evidence-dir", str(EV_ROOT / "selected-unload"))
ok1 = code == 0 and out.get("verified") == "STATE_CONFIRMED"
code2, out2 = drv("click", "--row", "2", "--action", "load", "--evidence-dir", str(EV_ROOT / "selected-load"))
record("selected_row_recovery", ok1 and code2 == 0 and out2.get("verified") == "STATE_CONFIRMED",
       {"unload": out.get("verified") or out.get("error"), "load": out2.get("verified") or out2.get("error")})

# --- 6. hidden app recovery
osa(f'tell application "System Events" to set visible of process "{APP}" to false')
time.sleep(0.3)
code, out = drv("state", "--row", "2")
record("hidden_app_recovery", code == 0 and out.get("rows", [{}])[0].get("state") == "loaded",
       {"state": out.get("rows", [{}])[0].get("state")})

# --- 7. verify-timeout receipt (click fires, verification given 1ms)
code, out = drv("click", "--row", "2", "--action", "unload", "--verify-timeout-ms", "1",
                "--evidence-dir", str(EV_ROOT / "timeout-unload"))
# with a 1ms budget either outcome is correct: the timeout receipt fired,
# or verification won the race and confirmed the state honestly
timeout_ok = ((code == 2 and out.get("error") == "UXP_STATE_VERIFY_TIMEOUT")
              or (code == 0 and out.get("verified") == "STATE_CONFIRMED"))
settled = wait_state("not_loaded", 5)          # single click may or may not land
if settled:                                     # restore only when needed
    code2, out2 = drv("click", "--row", "2", "--action", "load")
    restored = code2 == 0 and out2.get("verified") == "STATE_CONFIRMED"
else:
    codeS, outS = drv("state", "--row", "2")
    restored = codeS == 0 and outS.get("rows", [{}])[0].get("state") == "loaded"
    out2 = {"verified": "ALREADY_LOADED"} if restored else outS
record("verify_timeout_receipt", timeout_ok and restored,
       {"error": out.get("error"), "click_landed_async": settled,
        "restore": out2.get("verified") or out2.get("error")})

# --- 8. unknown plugin name
code, out = drv("state", "--plugin-name", "does-not-exist-plugin")
record("unknown_plugin_name", code == 3 and out.get("error") == "UXP_ROW_NOT_FOUND",
       {"error": out.get("error")})

# --- 9. lock busy
lock = open("/tmp/uxp-ui-driver.lock", "w")
fcntl.flock(lock, fcntl.LOCK_EX)
code, out = drv("state", "--row", "1", "--lock-timeout-ms", "200")
fcntl.flock(lock, fcntl.LOCK_UN)
record("lock_busy", code == 5 and out.get("error") == "UXP_DRIVER_BUSY", {"error": out.get("error")})

# --- final state guard
code, out = drv("state", "--row", "2")
record("final_state_loaded", code == 0 and out.get("rows", [{}])[0].get("state") == "loaded",
       {"state": out.get("rows", [{}])[0].get("state")})

passed = sum(1 for r in RESULTS if r["pass"])
report = {"passed": passed, "total": len(RESULTS), "results": RESULTS}
(EV_ROOT / "e2e-report.json").write_text(json.dumps(report, indent=2))
print(f"\n{passed}/{len(RESULTS)} scenarios passed -> {EV_ROOT / 'e2e-report.json'}")
sys.exit(0 if passed == len(RESULTS) else 1)
