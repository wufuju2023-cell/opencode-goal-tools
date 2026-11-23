#!/usr/bin/env python3
"""Deterministic end-to-end check for the goal-tools goal space.

Covers:
  - per-session isolation
  - long details / status / tags / stats
  - completion recorded with completedBy + completedAt (including a child)
  - automatic mirroring of a built-in goal into a detailed record
  - the goal-met reminder when the judged goal completes while an open
    goal-space record remains

Run: python3 test/e2e_space.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time

OC = os.path.expanduser("~/.opencode2/bin/opencode")
BASE = f"/tmp/opencode/goal-space-e2e-{int(time.time())}"
MODEL = "opencode-go/deepseek-v4.1-flash#max"


def sh(args: list[str], timeout: int = 90) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def api(root: str, method: str, path: str, data: dict | None = None, timeout: int = 90) -> dict:
    cmd = [OC, "api", method, path, "-H", f"x-opencode-directory: {root}"]
    if data is not None:
        cmd += ["--data", json.dumps(data, ensure_ascii=False)]
    last = ""
    for _ in range(4):
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


def rpc(root: str, name: str, method: str, payload: dict) -> dict | list:
    result = api(root, "post", f"/api/rpc/{name}/{method}", {"input": payload})
    if "_tag" in result:
        raise RuntimeError(f"rpc {name}/{method} failed: {result}")
    return result.get("output")


def create(root: str, title: str, agent: str = "build", parent: str | None = None) -> dict:
    payload: dict = {"title": title, "agent": agent, "location": {"directory": root}}
    if parent:
        payload["parentID"] = parent
    return api(root, "post", "/api/session", payload)["data"]


def wait_idle(root: str, session_id: str, timeout: float) -> None:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = api(root, "get", f"/api/session/{session_id}")["data"]
        busy = last.get("time", {}).get("busy")
        idle = last.get("time", {}).get("idle")
        if busy is None or (idle is not None and idle >= busy):
            return
        time.sleep(1)
    raise RuntimeError(f"timed out waiting for idle: {json.dumps(last)[:500]}")


def messages(root: str, session_id: str) -> list[dict]:
    return api(root, "get", f"/api/session/{session_id}/message").get("data", [])


def wait_synthetic(root: str, session_id: str, needle: str, timeout: float) -> str:
    deadline = time.time() + timeout
    last: list[str] = []
    while time.time() < deadline:
        last = [m.get("text") or "" for m in messages(root, session_id) if m.get("type") == "synthetic"]
        for text in last:
            if needle in text:
                return text
        time.sleep(1)
    raise RuntimeError(f"timed out waiting for {needle!r}: {last[-3:]}")


def setup_project(path: str) -> None:
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "opencode.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {"$schema": "https://opencode.ai/config.json", "model": MODEL, "experimental": {"subagent_depth": 2}},
            handle,
            indent=2,
        )


def main() -> int:
    evidence: dict = {"base": BASE}
    setup_project(BASE)
    print("[1/7] root A: add a detailed record, isolation, completion by a child")
    root_a = create(BASE, "space-a")
    root_a_id = root_a["id"]
    api(BASE, "post", f"/api/session/{root_a_id}/prompt", {"text": "Reply with exactly OK."})
    wait_idle(BASE, root_a_id, 120)
    add_a = rpc(
        BASE,
        "goaltools",
        "spaceAdd",
        {
            "fromSessionID": root_a_id,
            "sessionID": root_a_id,
            "input": {
                "title": "Experiment plan A",
                "details": "Run 10 seeds; compare baseline vs GaLore; record loss, memory and wall clock.",
                "status": "planned",
                "tags": ["experiments", "galore"],
            },
        },
    )
    assert add_a["status"] == "planned" and len(add_a["details"]) > 20, add_a
    space_a = rpc(BASE, "goaltools", "space", {"sessionID": root_a_id})
    assert len(space_a["goals"]) == 1, space_a
    evidence["add"] = add_a

    child = create(BASE, "space-child", "general", root_a_id)
    child_id = child["id"]
    denied = rpc(
        BASE,
        "goaltools",
        "spaceAdd",
        {
            "fromSessionID": root_a_id,
            "sessionID": child_id,
            "input": {"title": "must fail"},
        },
    )
    assert denied.get("ok") is False and "isolated" in str(denied.get("error")), denied
    space_child = rpc(BASE, "goaltools", "space", {"sessionID": child_id})
    assert space_child["goals"] == [], space_child
    evidence["isolation"] = denied

    completed = rpc(
        BASE,
        "goaltools",
        "spaceComplete",
        {
            "fromSessionID": root_a_id,
            "sessionID": root_a_id,
            "goalID": add_a["id"],
            "result": "child ran 10 seeds",
            "completedBy": child_id,
        },
    )
    assert completed["status"] == "done", completed
    assert completed["completedBy"] == child_id, completed
    assert completed["completedByAgent"] == "general", completed
    assert completed["completedAt"] > 0, completed
    stats = rpc(BASE, "goaltools", "spaceStats", {"sessionID": root_a_id})
    assert stats["byStatus"]["done"] == 1, stats
    assert stats["byCompleted"][child_id] == 1, stats
    assert stats["byCompletedAgent"]["general"] == 1, stats
    evidence["completed"] = completed
    evidence["stats"] = stats
    print("      isolation + completedBy/At ok")

    print("[2/7] root B: mirror a built-in goal and emit a goal-met reminder")
    root_b = create(BASE, "space-b")
    root_b_id = root_b["id"]
    api(BASE, "post", f"/api/session/{root_b_id}/prompt", {"text": "Reply with exactly OK."})
    wait_idle(BASE, root_b_id, 120)
    # Keep auto-research out of this scenario so the assertion sees the
    # goal-met reminder without a second nudge.
    rpc(BASE, "goaltools", "researchSet", {"sessionID": root_b_id, "enabled": False})
    open_record = rpc(
        BASE,
        "goaltools",
        "spaceAdd",
        {
            "fromSessionID": root_b_id,
            "sessionID": root_b_id,
            "input": {
                "title": "Open follow-up experiment",
                "details": "Ablate the rank and measure the loss gap.",
                "status": "planned",
            },
        },
    )
    assigned = rpc(
        BASE,
        "goaltools",
        "assign",
        {
            "fromSessionID": root_b_id,
            "sessionID": root_b_id,
            "objective": "Reply with exactly GOAL-SPACE-OK and stop.",
            "notify": False,
        },
    )
    assert assigned["goal"]["status"] == "active", assigned

    print("[3/7] wait for the judge and the goal-space mirror")
    deadline = time.time() + 180
    goal = None
    while time.time() < deadline:
        state = rpc(BASE, "goaltools", "state", {"sessionID": root_b_id})
        goal = state.get("goal")
        if goal and goal.get("status") == "complete":
            break
        time.sleep(2)
    assert goal and goal.get("status") == "complete", goal
    goal_id = goal["id"]

    deadline = time.time() + 60
    mirrored = None
    while time.time() < deadline:
        space_b = rpc(BASE, "goaltools", "space", {"sessionID": root_b_id})
        mirrored = next((record for record in space_b["goals"] if record.get("goalID") == goal_id), None)
        if mirrored and mirrored.get("status") == "done":
            break
        time.sleep(2)
    assert mirrored and mirrored["status"] == "done", mirrored
    assert mirrored.get("completedBy") == root_b_id, mirrored
    assert mirrored.get("completedAt", 0) > 0, mirrored
    evidence["mirror"] = mirrored

    print("[4/7] goal-met reminder because an open record remains")
    reminder = wait_synthetic(BASE, root_b_id, "[goal-met]", 60)
    assert "Update the active goal" in reminder, reminder
    assert "Open follow-up experiment" in reminder, reminder
    assert "goal_space" in reminder and "goal_list" in reminder, reminder
    evidence["goalMetReminder"] = reminder
    print("      ", reminder.splitlines()[0])

    print("[5/7] stats include both roots and the child completion")
    stats_b = rpc(BASE, "goaltools", "spaceStats", {"sessionID": root_b_id})
    assert stats_b["total"] >= 2, stats_b
    assert stats_b["byStatus"].get("done", 0) >= 1, stats_b
    evidence["statsB"] = stats_b

    print("[6/7] goal space and goal list remain separate stores")
    list_b = rpc(BASE, "goaltools", "list", {"sessionID": root_b_id})
    assert list_b["tasks"] == [], list_b
    evidence["listB"] = list_b

    print("[7/7] PASS")
    evidence["result"] = "pass"
    with open(os.path.join(BASE, "evidence.json"), "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, ensure_ascii=False, indent=2)
    print(
        json.dumps(
            {
                "rootA": root_a_id,
                "rootB": root_b_id,
                "child": child_id,
                "goalRecord": mirrored["id"],
                "openRecord": open_record["id"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print("PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
