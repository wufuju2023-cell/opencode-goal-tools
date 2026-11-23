#!/usr/bin/env python3
"""Real-TUI end-to-end check for goal-tools goal space + auto research.

TUI drives the model (tmux + real PTY); pass/fail comes from the HTTP API:
tool calls, goal-space records, goal-list tasks and auto-research state.

Run: python3 test/e2e_tui.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time

OC = os.path.expanduser("~/.opencode2/bin/opencode")
RUN = int(time.time())
ROOT = f"/tmp/opencode/goal-tools-tui-e2e-{RUN}"
TMUX = "goal-tools-e2e"
MODEL = "opencode-go/deepseek-v4.1-flash#max"


def sh(args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def api(method: str, path: str, data: dict | None = None, timeout: int = 90) -> dict:
    cmd = [OC, "api", method, path, "-H", f"x-opencode-directory: {ROOT}"]
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


def rpc(name: str, method: str, payload: dict) -> dict | list:
    result = api("post", f"/api/rpc/{name}/{method}", {"input": payload})
    if "_tag" in result:
        raise RuntimeError(f"rpc {name}/{method} failed: {result}")
    return result.get("output")


def tmux(*args: str, timeout: int = 20) -> str:
    return sh(["tmux", *args], timeout=timeout).stdout


def send(text: str) -> None:
    tmux("send-keys", "-t", TMUX, "-l", text)
    tmux("send-keys", "-t", TMUX, "Enter")


def capture() -> str:
    return tmux("capture-pane", "-p", "-t", TMUX, "-S", "-500")


def wait_for_text(text: str, timeout: int = 90) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture()
        if text in last:
            return last
        time.sleep(1)
    raise RuntimeError(f"timed out waiting for {text!r}; last screen:\n{last[-3000:]}")


def session(session_id: str) -> dict:
    return api("get", f"/api/session/{session_id}")["data"]


def wait_idle(session_id: str, timeout: float, what: str) -> None:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = session(session_id)
        busy = last.get("time", {}).get("busy")
        idle = last.get("time", {}).get("idle")
        if busy is None or (idle is not None and idle >= busy):
            return
        time.sleep(1)
    raise RuntimeError(f"timed out waiting for {what}: {json.dumps(last)[:500]}")


def messages(session_id: str) -> list[dict]:
    return api("get", f"/api/session/{session_id}/message").get("data", [])


def tool_calls(session_id: str) -> list[dict]:
    calls = []
    for message in messages(session_id):
        for part in message.get("content") or []:
            if part.get("type") != "tool":
                continue
            state = part.get("state") or {}
            calls.append(
                {
                    "name": part.get("name") or part.get("tool"),
                    "input": state.get("input"),
                    "status": state.get("status"),
                }
            )
    return calls


def main() -> int:
    evidence: dict = {"root": ROOT}
    try:
        sh(["tmux", "kill-session", "-t", TMUX])
    except Exception:
        pass
    shutil.rmtree(ROOT, ignore_errors=True)
    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, "opencode.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {"$schema": "https://opencode.ai/config.json", "model": MODEL, "experimental": {"subagent_depth": 2}},
            handle,
            indent=2,
        )

    print(f"[1/6] create main session and start real TUI in {ROOT}")
    main_session = api(
        "post",
        "/api/session",
        {"title": "goal-tools-tui", "agent": "build", "location": {"directory": ROOT}},
    )["data"]
    main_id = main_session["id"]
    evidence["main"] = main_id
    sh(
        [
            "tmux",
            "new-session",
            "-d",
            "-s",
            TMUX,
            "-x",
            "200",
            "-y",
            "50",
            "cd {root} && XDG_STATE_HOME=~/.opencode2/state XDG_CONFIG_HOME=~/.opencode2/config "
            "XDG_DATA_HOME=~/.opencode2/share XDG_CACHE_HOME=~/.opencode2/cache "
            "exec {oc} --session {sid}; echo EXIT=$?; sleep 86400".format(root=ROOT, oc=OC, sid=main_id),
        ]
    )
    tmux("set-option", "-t", TMUX, "window-size", "manual")
    for _ in range(20):
        time.sleep(1)
        screen = capture()
        if "DeepSeek V4.1 Flash" in screen:
            break
        if "What's new" in screen or "release notes" in screen.lower():
            tmux("send-keys", "-t", TMUX, "Escape")
    wait_for_text("DeepSeek V4.1 Flash", 120)

    print("[2/6] ask the model to use goal_space, auto_research and goal_list")
    prompt = (
        "You are the main agent. Do these steps in order, do not ask questions. "
        'Step 1: call goal_space with action "add", title "TUI goal-space plan", '
        'details "Run 5 seeds of the GaLore ablation and record loss, memory and wall clock.", '
        'status "planned", tags ["tui", "galore"]. '
        'Step 2: call auto_research with action "off" so this test does not trigger the automatic research loop. '
        'Step 3: call goal_list with action "add", startNow false, tasks ["TUI follow-up task"]. '
        "Then report the goal_space record ID and confirm auto research is off."
    )
    send(prompt)
    wait_for_text("DeepSeek V4.1 Flash", 10)
    # wait_idle can return before the model picks up the prompt; wait until the
    # three requested tool calls have actually landed, then wait for idle.
    deadline = time.time() + 240
    while time.time() < deadline:
        names = [call["name"] for call in tool_calls(main_id)]
        if all(name in names for name in ("goal_space", "auto_research", "goal_list")):
            break
        time.sleep(2)
    wait_idle(main_id, 300, "main idle after tool calls")

    print("[3/6] assert the tool calls")
    calls = tool_calls(main_id)
    names = [call["name"] for call in calls]
    evidence["calls"] = calls
    for required in ("goal_space", "auto_research", "goal_list"):
        assert required in names, f"missing {required}: {names}"
    add = next(
        call for call in calls if call["name"] == "goal_space" and call["input"].get("action") == "add"
    )
    assert add["input"].get("title") == "TUI goal-space plan", add
    status = next(
        call for call in calls if call["name"] == "auto_research" and call["input"].get("action") == "off"
    )
    evidence["goalSpaceCall"] = add
    evidence["autoResearchCall"] = status

    print("[4/6] assert the goal-space record and long details")
    space = rpc("goaltools", "space", {"sessionID": main_id})
    record = next((item for item in space["goals"] if item["title"] == "TUI goal-space plan"), None)
    assert record is not None, space
    assert "5 seeds" in record["details"], record
    assert record["status"] == "planned", record
    assert "tui" in record["tags"], record
    evidence["record"] = record

    print("[5/6] assert the goal-list task and auto-research status")
    listing = rpc("goaltools", "list", {"sessionID": main_id})
    assert any(task["text"] == "TUI follow-up task" for task in listing["tasks"]), listing
    research = rpc("goaltools", "research", {"sessionID": main_id})
    assert research["enabled"] is False, research
    assert research["spaceRecords"] >= 1, research
    evidence["list"] = listing
    evidence["research"] = research

    print("[6/6] model pin and PASS")
    used = {
        (message["model"]["providerID"], message["model"]["id"], message["model"].get("variant"))
        for message in messages(main_id)
        if message.get("type") == "assistant" and message.get("model")
    }
    assert used == {("opencode-go", "deepseek-v4.1-flash", "max")}, used
    screen = capture()
    with open(os.path.join(ROOT, "tui-final.txt"), "w", encoding="utf-8") as handle:
        handle.write(screen)
    assert "DeepSeek V4.1 Flash" in screen, "TUI lost the pinned model line"
    evidence["models"] = list(used)
    evidence["result"] = "pass"
    with open(os.path.join(ROOT, "evidence.json"), "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"main": main_id, "record": record["id"], "task": listing["tasks"][-1]["id"]}, indent=2))
    print("PASS")
    sh(["tmux", "kill-session", "-t", TMUX])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        try:
            screen = capture()
            with open(os.path.join(ROOT, "tui-failure.txt"), "w", encoding="utf-8") as handle:
                handle.write(screen)
            print(screen[-4000:], file=sys.stderr)
        except Exception:
            pass
        sys.exit(1)
