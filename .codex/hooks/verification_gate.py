#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

PROJECT_ROOT = Path(__file__).resolve().parents[2]
STATE_SCRIPT = PROJECT_ROOT / "scripts" / "verification-state.py"
ASSIGNMENT_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
READY_CLAIM_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE | re.MULTILINE)
    for pattern in (
        r"\bready to push\b",
        r"\bready for (?:a )?push\b",
        r"\bready to be pushed\b",
        r"\b(?:all requested work|changes?|everything|fix|implementation|task|work) "
        r"(?:is|are) (?:complete|completed|done|finished|ready|verified)\b",
        r"\b(?:fixed|implemented),?\s+(?:and\s+)?(?:tested|verified)\b",
        r"\b(?:all checks|full verification|ready verification) "
        r"(?:pass|passed|succeeded)\b",
        r"\btests? (?:all )?(?:are passing|pass|passed)\b",
        r"^\s*(?:all )?(?:complete|completed|done|finished|fixed|implemented|verified)"
        r"\s*[.!]?\s*$",
    )
)
INCOMPLETE_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\bnot (?:complete|done|ready|verified)\b",
        r"\bnot yet\b",
        r"\bnot (?:been )?run\b",
        r"\bblocked\b",
        r"\bdo not push\b",
        r"\b(?:build|checks?|gate|tests?|verification) "
        r"(?:are |is |remain |remains )?(?:failed|failing)\b",
        r"\bstill (?:need|needs|requires?|running|working)\b",
    )
)
GIT_OPTIONS_WITH_VALUES = frozenset(
    {
        "-c",
        "--config-env",
        "--git-dir",
        "--namespace",
        "--work-tree",
    }
)


@dataclass(frozen=True)
class GitPush:
    cwd: Path
    bypasses_hooks: bool


def command_segments(command: str) -> Iterable[list[str]]:
    try:
        lexer = shlex.shlex(
            command,
            posix=True,
            punctuation_chars=";&|()",
        )
        lexer.commenters = ""
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return []

    segments: list[list[str]] = []
    segment: list[str] = []
    for token in tokens:
        if token and all(character in ";&|()" for character in token):
            if segment:
                segments.append(segment)
                segment = []
            continue
        segment.append(token)
    if segment:
        segments.append(segment)
    return segments


def command_index(segment: list[str]) -> int | None:
    index = 0
    while index < len(segment) and ASSIGNMENT_PATTERN.match(segment[index]):
        index += 1
    if index < len(segment) and segment[index] == "env":
        index += 1
        while index < len(segment):
            token = segment[index]
            if ASSIGNMENT_PATTERN.match(token):
                index += 1
                continue
            if token.startswith("-"):
                index += 1
                continue
            break
    if index < len(segment) and segment[index] == "command":
        index += 1
        while index < len(segment) and segment[index].startswith("-"):
            index += 1
    return index if index < len(segment) else None


def git_push(segment: list[str], cwd: Path) -> GitPush | None:
    index = command_index(segment)
    if index is None or Path(segment[index]).name != "git":
        return None
    index += 1
    effective_cwd = cwd
    while index < len(segment):
        token = segment[index]
        if token == "-C":
            index += 1
            if index >= len(segment):
                return None
            directory = Path(segment[index])
            effective_cwd = (
                directory
                if directory.is_absolute()
                else effective_cwd / directory
            ).resolve()
            index += 1
            continue
        if token.startswith("-C") and token != "-C":
            directory = Path(token[2:])
            effective_cwd = (
                directory
                if directory.is_absolute()
                else effective_cwd / directory
            ).resolve()
            index += 1
            continue
        if token in GIT_OPTIONS_WITH_VALUES:
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        if token != "push":
            return None
        arguments = segment[index + 1 :]
        bypasses_hooks = any(
            argument == "--no-verify" or argument.startswith("--no-verify=")
            for argument in arguments
        )
        return GitPush(effective_cwd, bypasses_hooks)
    return None


def find_pushes(command: str, cwd: Path) -> list[GitPush]:
    return [
        push
        for segment in command_segments(command)
        if (push := git_push(segment, cwd)) is not None
    ]


def git_value(cwd: Path, *arguments: str) -> str | None:
    result = subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def common_git_directory(cwd: Path) -> Path | None:
    root_value = git_value(cwd, "rev-parse", "--show-toplevel")
    common_value = git_value(cwd, "rev-parse", "--git-common-dir")
    if root_value is None or common_value is None:
        return None
    common = Path(common_value)
    return common if common.is_absolute() else (Path(root_value) / common).resolve()


def is_stowplan_repository(cwd: Path) -> bool:
    return common_git_directory(cwd) == common_git_directory(PROJECT_ROOT)


def is_verified(cwd: Path) -> bool:
    result = subprocess.run(
        [
            sys.executable,
            str(STATE_SCRIPT),
            "check",
            "--quiet",
            "--require-clean",
            "HEAD",
        ],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def emit_pre_tool_denial(reason: str) -> None:
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            },
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


def message_claims_readiness(message: str) -> bool:
    if any(pattern.search(message) for pattern in INCOMPLETE_PATTERNS):
        return False
    return any(pattern.search(message) for pattern in READY_CLAIM_PATTERNS)


def handle_pre_tool_use(payload: dict[str, Any]) -> int:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    command = tool_input.get("command")
    cwd_value = payload.get("cwd")
    if not isinstance(command, str) or not isinstance(cwd_value, str):
        return 0
    pushes = find_pushes(command, Path(cwd_value))
    if any(push.bypasses_hooks for push in pushes):
        emit_pre_tool_denial(
            "git push --no-verify is disabled for Stowplan; run npm run verify:ready",
        )
        return 0
    for push in pushes:
        if is_stowplan_repository(push.cwd) and not is_verified(push.cwd):
            emit_pre_tool_denial(
                "This Stowplan HEAD has not passed npm run verify:ready with a clean worktree",
            )
            return 0
    return 0


def handle_stop(payload: dict[str, Any]) -> int:
    message = payload.get("last_assistant_message")
    cwd_value = payload.get("cwd")
    if not isinstance(message, str) or not isinstance(cwd_value, str):
        return 0
    cwd = Path(cwd_value)
    if (
        message_claims_readiness(message)
        and is_stowplan_repository(cwd)
        and not is_verified(cwd)
    ):
        json.dump(
            {
                "decision": "block",
                "reason": (
                    "Do not claim this work is done or ready to push. Commit the final changes, "
                    "run npm run verify:ready, and report the exact result."
                ),
            },
            sys.stdout,
        )
        sys.stdout.write("\n")
    return 0


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    if not isinstance(payload, dict):
        return 0
    event = payload.get("hook_event_name")
    if event == "PreToolUse":
        return handle_pre_tool_use(payload)
    if event == "Stop":
        return handle_stop(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
