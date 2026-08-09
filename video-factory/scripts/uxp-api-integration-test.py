#!/usr/bin/env python3
"""Integration tests for the /api/uxp/* routes against a live server."""
import concurrent.futures, json, subprocess, sys, time, urllib.request, urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3033"
RESULTS = []

def call(method, path, body=None, timeout=45):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"content-type": "application/json"})
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, {}
    except Exception as e:
        return 0, {"transport_error": str(e)}

def record(name, passed, detail):
    RESULTS.append({"test": name, "pass": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL "), name, "-", json.dumps(detail)[:200])

# 1. ui-state
st, out = call("GET", "/api/uxp/ui-state")
rows = out.get("rows", [])
record("ui_state", st == 200 and len(rows) == 2,
       {"status": st, "rows": len(rows), "ms": out.get("elapsed_ms")})

# 2. unload by plugin_name
st, out = call("POST", "/api/uxp/plugin-action",
               {"plugin_name": "editstudio", "action": "unload"})
record("unload_by_name", st == 200 and out.get("verified") == "STATE_CONFIRMED",
       {"status": st, "verified": out.get("verified"), "row_name": out.get("row_name")})

# 3. load restore by plugin_name
st, out = call("POST", "/api/uxp/plugin-action",
               {"plugin_name": "editstudio", "action": "load"})
record("load_by_name", st == 200 and out.get("verified") == "STATE_CONFIRMED",
       {"status": st, "verified": out.get("verified")})

# 4. validation error: bad action
st, out = call("POST", "/api/uxp/plugin-action", {"row": 2, "action": "explode"})
record("validation_bad_action", st == 422 and out.get("error", {}).get("code") == "API_VALIDATION_FAILED",
       {"status": st, "code": out.get("error", {}).get("code")})

# 5. validation error: no row/name
st, out = call("POST", "/api/uxp/plugin-action", {"action": "load"})
record("validation_no_target", st == 422, {"status": st})

# 6. wrong-state action -> 409
st, out = call("POST", "/api/uxp/plugin-action", {"row": 2, "action": "load"})
record("wrong_state_409", st == 409 and out.get("error", {}).get("code") == "UXP_ACTION_NOT_AVAILABLE",
       {"status": st, "code": out.get("error", {}).get("code")})

# 7. unknown plugin -> UXP_ROW_NOT_FOUND
st, out = call("POST", "/api/uxp/plugin-action",
               {"plugin_name": "no-such-plugin", "action": "load"})
record("unknown_plugin", st == 503 and out.get("error", {}).get("code") == "UXP_ROW_NOT_FOUND",
       {"status": st, "code": out.get("error", {}).get("code")})

# 8. concurrency: two simultaneous unloads serialize via the driver lock;
#    exactly one may confirm, none may 500, final state must be recoverable
with concurrent.futures.ThreadPoolExecutor(2) as ex:
    f1 = ex.submit(call, "POST", "/api/uxp/plugin-action", {"row": 2, "action": "unload"}, 60)
    f2 = ex.submit(call, "POST", "/api/uxp/plugin-action", {"row": 2, "action": "unload"}, 60)
(s1, o1), (s2, o2) = f1.result(), f2.result()
statuses = sorted([s1, s2])
confirms = sum(1 for o in (o1, o2) if o.get("verified") == "STATE_CONFIRMED")
no_500 = all(s in (200, 409, 429, 503) for s in (s1, s2))
st, out = call("POST", "/api/uxp/plugin-action", {"plugin_name": "editstudio", "action": "load"})
record("concurrent_unloads", no_500 and confirms <= 1 and st == 200,
       {"statuses": statuses, "confirms": confirms, "restore": out.get("verified")})

# 9. error log grew from the failure cases above
import pathlib
log = pathlib.Path(__file__).resolve().parent.parent / "work/uxp-ui-driver-errors.jsonl"
lines = log.read_text().strip().splitlines() if log.exists() else []
codes = [json.loads(l).get("code") for l in lines[-10:]]
record("error_log_written", "UXP_ROW_NOT_FOUND" in codes and "UXP_ACTION_NOT_AVAILABLE" in codes,
       {"recent_codes": codes[-6:]})

# 10. final state
st, out = call("GET", "/api/uxp/ui-state")
states = [r.get("state") for r in out.get("rows", [])]
record("final_both_loaded", st == 200 and states == ["loaded", "loaded"], {"states": states})

passed = sum(1 for r in RESULTS if r["pass"])
print(f"\n{passed}/{len(RESULTS)} integration tests passed")
sys.exit(0 if passed == len(RESULTS) else 1)
