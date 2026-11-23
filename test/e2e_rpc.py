#!/usr/bin/env python3
"""Deterministic HTTP/RPC end-to-end check for goal-tools.

Covers cross-agent goal assignment (with the synthetic notice), goal list
add/sync/promotion, and the built-in goal engine's pause/resume/clear through
the same command path the tool uses.

Run: python3 test/e2e_rpc.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time

OC = os.path.expanduser("~/.opencode2/bin/opencode")
ROOT = f"/tmp/opencode/goal-tools-rpc-e2e-{int(time.time())}"
MODEL = "opencode-go/deepseek-v4.1-flash#max"


def sh(args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def api(method: str, path: str, data: dict | None = None, timeout: int = 90) -> dict:
    cmd = [OC, "api", method, path, "-H", f"x-opencode-directory: {ROOT}"]
    if data is not None:
        cmd += ["--data", json.dumps(data, ensure_ascii=False)]
    last = ""
    for _ in range(3):
        proc = sh(cmd, timeout=timeout)
        out = (proc.stdout or "").strip()
        last = out or proc.stderr.strip()
        for line in out.splitlines():
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
        if "not found" in last.lower() or "unavailable" in last.lower():
            time.sleep(1.5)
            continue
        break
    raise RuntimeError(f"api {method} {path} failed: {last[:800]}")


def rpc(name: str, method: str, payload: dict) -> dict:
    result = api("post", f"/api/rpc/{name}/{method}", {"input": payload})
    if "_tag" in result:
        raise RuntimeError(f"rpc {name}/{method} failed: {result}")
    return result.get("output")


def command(session_id: str, text: str) -> None:
    proc = sh(
        [
            OC,
            "api",
            "post",
            f"/api/session/{session_id}/command",
            "-H",
            f"x-opencode-directory: {ROOT}",
            "--data",
            json.dumps({"name": "goal", "text": text}),
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError(f"goal command {text!r} failed: {proc.stderr.strip()[:500]}")


def messages(session_id: str) -> list[dict]:
    return api("get", f"/api/session/{session_id}/message").get("data", [])


def wait_goal(session_id: str, status: str, timeout: float = 180) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = rpc("goaltools", "state", {"sessionID": session_id})
        if (last.get("goal") or {}).get("status") == status:
            return last
        time.sleep(2)
    raise RuntimeError(f"timed out waiting for goal {status}: {last}")


def main() -> int:
    shutil.rmtree(ROOT, ignore_errors=True)
    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, "opencode.json"), "w", encoding="utf-8") as handle:
        json.dump({"$schema": "https://opencode.ai/config.json", "model": MODEL}, handle, indent=2)
    evidence: dict = {"root": ROOT}

    print("[1/6] create root + child and load plugins")
    root = api("post", "/api/session", {"title": "goal-root", "agent": "build", "location": {"directory": ROOT}})["data"]
    root_id = root["id"]
    api("post", f"/api/session/{root_id}/prompt", {"text": "Reply with exactly OK."})
    deadline = time.time() + 120
    while time.time() < deadline:
        info = api("get", f"/api/session/{root_id}")["data"]
        busy = info.get("time", {}).get("busy")
        idle = info.get("time", {}).get("idle")
        if busy is None or (idle is not None and idle >= busy):
            break
        time.sleep(1)
    child = api(
        "post",
        "/api/session",
        {"title": "goal-child", "agent": "general", "parentID": root_id, "location": {"directory": ROOT}},
    )["data"]
    child_id = child["id"]
    evidence["rootID"] = root_id
    evidence["childID"] = child_id
    print(f"      root={root_id} child={child_id}")

    print("[2/6] parent assigns a goal directly (system message + engine kickoff)")
    rpc("goaltools", "researchSet", {"sessionID": child_id, "enabled": False})
    assigned = rpc(
        "goaltools",
        "assign",
        {"fromSessionID": root_id, "sessionID": child_id, "objective": "Create the file rpc-goal.txt in your current working directory with content GOAL-ONE, then stop.", "notify": True},
    )
    assert assigned["goal"]["status"] == "active", assigned
    evidence["assign"] = assigned["goal"]

    print("[3/6] wait for the judge, then check the notice and add a follow-up task")
    wait_goal(child_id, "complete", 180)
    assert os.path.isfile(os.path.join(ROOT, "rpc-goal.txt")), "child did not create rpc-goal.txt"
    # The notice is queued behind the engine's kickoff turn, so it lands after
    # the goal run rather than at the instant assign returns.
    deadline = time.time() + 60
    texts: list[str] = []
    while time.time() < deadline:
        texts = [message.get("text") or "" for message in messages(child_id)]
        if any("[goal-update from" in text and "GOAL-ONE" in text for text in texts):
            break
        time.sleep(2)
    assert any("[goal-update from" in text and "GOAL-ONE" in text for text in texts), texts[-6:]
    print("      notice present")
    added = rpc(
        "goaltools",
        "add",
        {"fromSessionID": root_id, "sessionID": child_id, "tasks": ["Create the file rpc-goal-2.txt in your current working directory with content GOAL-TWO, then stop."], "startNow": False},
    )
    assert added["list"]["tasks"][-1]["status"] == "pending", added
    synced = rpc("goaltools", "sync", {"fromSessionID": root_id, "sessionID": child_id})
    assert synced["action"] == "promoted", synced
    assert synced["task"]["status"] == "active", synced
    evidence["promote"] = synced["task"]
    print("      promoted:", synced["task"]["text"])
    wait_goal(child_id, "complete", 180)
    deadline = time.time() + 60
    state = None
    while time.time() < deadline:
        state = rpc("goaltools", "state", {"sessionID": child_id})
        if all(task["status"] == "done" for task in state["list"]["tasks"]):
            break
        time.sleep(2)
    assert state is not None and all(task["status"] == "done" for task in state["list"]["tasks"]), state
    assert os.path.isfile(os.path.join(ROOT, "rpc-goal-2.txt")), "child did not create rpc-goal-2.txt"

    print("[4/6] pause / resume / clear through the built-in command path")
    # Use a fresh goal that stays active long enough to control it.
    control = api(
        "post",
        "/api/session",
        {"title": "goal-control", "agent": "general", "parentID": root_id, "location": {"directory": ROOT}},
    )["data"]
    control_id = control["id"]
    rpc(
        "goaltools",
        "assign",
        {
            "fromSessionID": root_id,
            "sessionID": control_id,
            "objective": "Run the shell command sleep 20 in the foreground, then reply DONE.",
            "notify": False,
        },
    )
    command(control_id, "pause")
    deadline = time.time() + 20
    state = None
    while time.time() < deadline:
        state = rpc("goaltools", "state", {"sessionID": control_id})
        if (state.get("goal") or {}).get("status") == "paused":
            break
        time.sleep(1)
    assert (state.get("goal") or {}).get("status") == "paused", state

    command(control_id, "resume")
    deadline = time.time() + 20
    while time.time() < deadline:
        state = rpc("goaltools", "state", {"sessionID": control_id})
        if (state.get("goal") or {}).get("status") == "active":
            break
        time.sleep(1)
    assert (state.get("goal") or {}).get("status") == "active", state

    command(control_id, "clear")
    deadline = time.time() + 20
    while time.time() < deadline:
        state = rpc("goaltools", "state", {"sessionID": control_id})
        if state.get("goal") is None:
            break
        time.sleep(1)
    assert state.get("goal") is None, state
    evidence["controls"] = "pause/resume/clear ok"
    print("      controls ok")

    print("[5/6] goal_tree lists the child")
    tree = rpc("goaltools", "state", {"sessionID": child_id})
    assert tree["list"]["tasks"], tree
    evidence["final"] = tree
    print("      tasks:", [(task["text"][:24], task["status"]) for task in tree["list"]["tasks"]])

    print("[6/6] PASS")
    evidence["result"] = "pass"
    with open(os.path.join(ROOT, "evidence.json"), "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
