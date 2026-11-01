#!/usr/bin/env python3
"""Create a reviewable private source checkpoint without touching the source repository.

Run only after the implementation freeze. Output and Git commit remain local.
Dependencies are copied separately so native rebuilds cannot mutate the source install.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


def run(root, *args):
    return subprocess.check_output(args, cwd=root)


def git_paths(root, *args):
    return [os.fsdecode(value) for value in run(root, "git", *args, "-z").split(b"\0") if value]


def digest(value):
    return hashlib.sha256(value).hexdigest()


def inventory_entry(root, path):
    target = root / path
    if target.is_symlink():
        value = os.fsencode(os.readlink(target))
        return {"path": path, "kind": "symlink", "target": os.fsdecode(value), "sha256": digest(value)}
    if target.is_file():
        return {"path": path, "kind": "file", "size": target.stat().st_size, "sha256": digest(target.read_bytes())}
    return {"path": path, "kind": "deleted"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--execute", action="store_true", help="Create the private checkout and local commit; default only writes inventory.")
    args = parser.parse_args()
    source, destination = Path(args.source).resolve(), Path(args.destination).resolve()
    if not str(destination).startswith("/private/tmp/") or destination == Path("/private/tmp"):
        raise SystemExit("Destination must be a new directory under /private/tmp.")
    if destination.exists():
        raise SystemExit("Refusing to overwrite an existing candidate directory.")
    original_head = run(source, "git", "rev-parse", "HEAD").decode().strip()
    tracked = git_paths(source, "ls-files")
    untracked = git_paths(source, "ls-files", "--others", "--exclude-standard")
    own_evidence = "docs/qa/evidence/railwise-0.5.4-markdown-workbench-20261101/"
    include_new = [path for path in untracked if path.startswith(("src/", "scripts/", "fixtures/markdown-workbench/"))
                   or (path.startswith("docs/") and (not path.startswith("docs/qa/evidence/") or path.startswith(own_evidence)))]
    entries = [inventory_entry(source, path) for path in sorted(set(tracked + include_new))]
    manifest = {"originalRepositoryHead": original_head, "originalRepository": str(source),
                "trackedDiffSha256": digest(run(source, "git", "diff", "HEAD", "--binary")),
                "includedUntracked": sorted(include_new), "excludedUntracked": sorted(set(untracked) - set(include_new)),
                "files": entries}
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    destination.mkdir(parents=True)
    (destination / "source-inventory.json").write_bytes(manifest_bytes)
    (destination / "source-inventory.sha256").write_text(digest(manifest_bytes) + "\n")
    if not args.execute:
        print(json.dumps({"inventory": str(destination / "source-inventory.json"), "sha256": digest(manifest_bytes), "files": len(entries)}, indent=2))
        return
    checkout = destination / "source"
    subprocess.run(["git", "clone", "--no-hardlinks", "--no-checkout", str(source), str(checkout)], check=True)
    subprocess.run(["git", "checkout", "-b", "codex/private-markdown-workbench-20261101", original_head], cwd=checkout, check=True)
    for entry in entries:
        target = checkout / entry["path"]
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.exists():
            raise SystemExit(f"Inventory path unexpectedly names a directory: {entry['path']}")
        if entry["kind"] == "deleted":
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if entry["kind"] == "symlink":
            target.symlink_to(entry["target"])
        else:
            shutil.copy2(source / entry["path"], target)
        if inventory_entry(checkout, entry["path"]) != entry:
            raise SystemExit(f"Source changed during snapshot: {entry['path']}")
    # Native rebuild hooks write into these directories; never share them via symlink.
    for relative in ("node_modules", "kun/node_modules", "build/sidecars", "converters"):
        origin, target = source / relative, checkout / relative
        if not origin.exists():
            continue
        target.mkdir(parents=True, exist_ok=True)
        subprocess.run(["cp", "-cR", str(origin) + "/.", str(target)], check=True)
    subprocess.run(["git", "add", "-A"], cwd=checkout, check=True)
    subprocess.run(["git", "-c", "user.name=Codex Private Candidate", "-c", "user.email=private-candidate@localhost", "commit", "-m", "Private Markdown workspace acceptance checkpoint"], cwd=checkout, check=True)
    candidate_head = run(checkout, "git", "rev-parse", "HEAD").decode().strip()
    if run(checkout, "git", "status", "--porcelain=v1", "--untracked-files=all").strip():
        raise SystemExit("Snapshot worktree is not clean.")
    if digest(run(source, "git", "diff", "HEAD", "--binary")) != manifest["trackedDiffSha256"]:
        raise SystemExit("Source changed during snapshot; do not build this checkpoint.")
    if run(source, "git", "rev-parse", "HEAD").decode().strip() != original_head:
        raise SystemExit("Original repository HEAD changed during snapshot; do not build this checkpoint.")
    for entry in entries:
        if inventory_entry(source, entry["path"]) != entry:
            raise SystemExit(f"Source changed after copy: {entry['path']}; do not build this checkpoint.")
    result = {"candidateHead": candidate_head, "originalRepositoryHead": original_head,
              "inventorySha256": digest(manifest_bytes), "source": str(checkout), "publicOperations": False}
    (destination / "private-checkpoint.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
