#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

SCHEMA_VERSION = 1
STATE_DIRECTORY = Path("stowplan") / "verified-ready"
REQUIRED_CHECKS = [
    "bash scripts/verify.sh",
    "bash scripts/verify-browser.sh",
]


class VerificationStateError(RuntimeError):
    pass


def run(
    command: Sequence[str],
    cwd: Path,
) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise VerificationStateError(detail or f"{' '.join(command)} failed")
    return result.stdout.strip()


def git(cwd: Path, *arguments: str) -> str:
    return run(["git", *arguments], cwd)


def repository_root(cwd: Path) -> Path:
    return Path(git(cwd, "rev-parse", "--show-toplevel"))


def common_git_directory(cwd: Path) -> Path:
    root = repository_root(cwd)
    common = Path(git(cwd, "rev-parse", "--git-common-dir"))
    if common.is_absolute():
        return common
    return (root / common).resolve()


def resolve_commit(cwd: Path, revision: str) -> str:
    return git(cwd, "rev-parse", "--verify", f"{revision}^{{commit}}")


def marker_path(cwd: Path, commit: str) -> Path:
    return common_git_directory(cwd) / STATE_DIRECTORY / f"{commit}.json"


def worktree_is_clean(cwd: Path) -> bool:
    return not git(
        cwd,
        "status",
        "--porcelain",
        "--untracked-files=all",
    )


def read_marker(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def marker_matches(path: Path, commit: str) -> bool:
    marker = read_marker(path)
    return bool(
        marker
        and marker.get("schema") == SCHEMA_VERSION
        and marker.get("commit") == commit
        and marker.get("checks") == REQUIRED_CHECKS
    )


def record(cwd: Path, revision: str) -> Path:
    commit = resolve_commit(cwd, revision)
    head = resolve_commit(cwd, "HEAD")
    if commit != head:
        raise VerificationStateError(
            f"Refusing to record {commit}: current HEAD is {head}",
        )
    if not worktree_is_clean(cwd):
        raise VerificationStateError(
            "Refusing to record verification for a dirty worktree",
        )

    path = marker_path(cwd, commit)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": SCHEMA_VERSION,
        "commit": commit,
        "checks": REQUIRED_CHECKS,
        "node": run(["node", "--version"], cwd),
        "npm": run(["npm", "--version"], cwd),
        "verifiedAt": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
    }
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{commit}.",
        suffix=".tmp",
        text=True,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
            json.dump(payload, temporary, indent=2, sort_keys=True)
            temporary.write("\n")
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
    return path


def clear(cwd: Path, revision: str) -> Path:
    commit = resolve_commit(cwd, revision)
    path = marker_path(cwd, commit)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    return path


def check(
    cwd: Path,
    revision: str,
    require_clean: bool,
) -> tuple[bool, str]:
    commit = resolve_commit(cwd, revision)
    path = marker_path(cwd, commit)
    if not marker_matches(path, commit):
        return False, f"Commit {commit} has not passed npm run verify:ready"
    if require_clean and not worktree_is_clean(cwd):
        return False, "The worktree changed after its verified commit"
    return True, f"Commit {commit} passed npm run verify:ready"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("revision", nargs="?", default="HEAD")
    check_parser.add_argument("--quiet", action="store_true")
    check_parser.add_argument("--require-clean", action="store_true")

    clear_parser = subparsers.add_parser("clear")
    clear_parser.add_argument("revision", nargs="?", default="HEAD")

    path_parser = subparsers.add_parser("path")
    path_parser.add_argument("revision", nargs="?", default="HEAD")

    record_parser = subparsers.add_parser("record")
    record_parser.add_argument("revision", nargs="?", default="HEAD")
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    cwd = Path.cwd()
    try:
        if arguments.command == "check":
            valid, message = check(
                cwd,
                arguments.revision,
                arguments.require_clean,
            )
            if not arguments.quiet or not valid:
                print(message, file=sys.stdout if valid else sys.stderr)
            return 0 if valid else 1
        if arguments.command == "clear":
            clear(cwd, arguments.revision)
            return 0
        if arguments.command == "path":
            commit = resolve_commit(cwd, arguments.revision)
            print(marker_path(cwd, commit))
            return 0
        path = record(cwd, arguments.revision)
        print(f"[verify] recorded exact commit at {path}")
        return 0
    except VerificationStateError as error:
        print(f"verification state error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
