#!/usr/bin/env python3
"""Constrained local-only MarkItDown bridge for WorkWise."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import math
import os
import re
import sys
import time
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

from markitdown import MarkItDown


ENGINE_VERSION = "markitdown-v0.1.4-workwise-1"
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".pptx", ".xlsx"}
MAX_INPUT_BYTES = 200 * 1024 * 1024
PPT_MASTER_MAX_REQUEST_PATH = 4096


def contained(root: Path, target: Path) -> bool:
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def safe_path(raw: Any, field: str) -> Path:
    if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
        raise ValueError(f"{field} is required")
    return Path(raw).expanduser().resolve(strict=False)


def ppt_master_root() -> Path:
    """Return the audited PPT Master snapshot bundled into the frozen sidecar."""
    frozen_root = getattr(sys, "_MEIPASS", "")
    candidates = [
        Path(frozen_root) / "ppt-master" if frozen_root else None,
        Path(os.environ["WORKWISE_PPT_MASTER_ROOT"]).expanduser()
        if os.environ.get("WORKWISE_PPT_MASTER_ROOT")
        else None,
        Path(__file__).resolve().parents[2] / "src" / "asset" / "skills" / "ppt-master",
    ]
    for candidate in candidates:
        if candidate and (candidate / "scripts" / "svg_to_pptx.py").is_file():
            return candidate.resolve(strict=True)
    raise ValueError("bundled PPT Master runtime is unavailable")


def bounded_ppt_path(root: Path, raw: Any, field: str, must_exist: bool) -> Path:
    if not isinstance(raw, str) or len(raw) > PPT_MASTER_MAX_REQUEST_PATH:
        raise ValueError(f"{field} is invalid")
    value = safe_path(raw, field)
    if not contained(root, value):
        raise ValueError(f"{field} must stay within workspaceRoot")
    if must_exist and not value.exists():
        raise ValueError(f"{field} does not exist")
    return value


def load_script_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"unable to load PPT Master module: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def call_ppt_master(operation: str, request: dict[str, Any]) -> dict[str, Any]:
    root = safe_path(request.get("workspaceRoot"), "workspaceRoot").resolve(strict=True)
    if not root.is_dir():
        raise ValueError("workspaceRoot must be a directory")
    skill_root = ppt_master_root()
    scripts_root = skill_root / "scripts"
    sys.path.insert(0, str(scripts_root))
    stdout = io.StringIO()
    stderr = io.StringIO()
    started = time.monotonic()
    exit_code = 0
    quality_check_payload: dict[str, Any] | None = None

    try:
        try:
            with redirect_stdout(stdout), redirect_stderr(stderr):
                if operation == "ppt-master-list-presets":
                    module = load_script_module(
                        "workwise_preset_shape_svg", scripts_root / "preset_shape_svg.py"
                    )
                    exit_code = int(module.main(["list"]) or 0)
                elif operation == "ppt-master-render-preset":
                    preset = request.get("presetName")
                    frame = request.get("frame")
                    fill = request.get("fill", "#1E3A5F")
                    if not isinstance(preset, str) or not re.fullmatch(
                        r"[A-Za-z0-9_]{1,80}", preset
                    ):
                        raise ValueError("presetName is invalid")
                    if (
                        not isinstance(frame, list)
                        or len(frame) != 4
                        or any(
                            not isinstance(value, (int, float))
                            or not math.isfinite(float(value))
                            or abs(float(value)) > 100_000
                            for value in frame
                        )
                    ):
                        raise ValueError("frame is invalid")
                    if not isinstance(fill, str) or not re.fullmatch(
                        r"#[0-9A-Fa-f]{6}", fill
                    ):
                        raise ValueError("fill is invalid")
                    module = load_script_module(
                        "workwise_preset_shape_svg", scripts_root / "preset_shape_svg.py"
                    )
                    exit_code = int(
                        module.main(
                            [
                                "render",
                                preset,
                                "--id",
                                f"preset-{int(time.time() * 1000)}",
                                "--frame",
                                *(str(float(value)) for value in frame),
                                "--fill",
                                fill,
                            ]
                        )
                        or 0
                    )
                elif operation == "ppt-master-import-pptx":
                    source = bounded_ppt_path(
                        root, request.get("inputPath"), "inputPath", True
                    )
                    output = bounded_ppt_path(
                        root,
                        request.get("outputDirectory"),
                        "outputDirectory",
                        False,
                    )
                    if (
                        source.suffix.lower() != ".pptx"
                        or source.stat().st_size > MAX_INPUT_BYTES
                    ):
                        raise ValueError(
                            "inputPath must be a PPTX no larger than 200 MiB"
                        )
                    output.mkdir(parents=True, exist_ok=True)
                    module = load_script_module(
                        "workwise_pptx_to_svg_cli", scripts_root / "pptx_to_svg.py"
                    )
                    previous_argv = sys.argv
                    try:
                        sys.argv = [
                            str(scripts_root / "pptx_to_svg.py"),
                            str(source),
                            "--output",
                            str(output),
                            "--embed-images",
                            "--inheritance-mode",
                            "flat",
                        ]
                        exit_code = int(module.main() or 0)
                    finally:
                        sys.argv = previous_argv
                elif operation == "ppt-master-import-pptx-native":
                    source = bounded_ppt_path(
                        root, request.get("inputPath"), "inputPath", True
                    )
                    output = bounded_ppt_path(
                        root,
                        request.get("outputDirectory"),
                        "outputDirectory",
                        False,
                    )
                    if (
                        source.suffix.lower() != ".pptx"
                        or source.stat().st_size > MAX_INPUT_BYTES
                    ):
                        raise ValueError(
                            "inputPath must be a PPTX no larger than 200 MiB"
                        )
                    output.mkdir(parents=True, exist_ok=True)
                    module = load_script_module(
                        "workwise_pptx_native_to_svg",
                        scripts_root / "pptx_native_to_svg.py",
                    )
                    module.convert_pptx_to_svg(str(source), str(output))
                elif operation == "ppt-master-export-pptx":
                    project = bounded_ppt_path(
                        root, request.get("projectPath"), "projectPath", True
                    )
                    output = bounded_ppt_path(
                        root, request.get("outputPath"), "outputPath", False
                    )
                    source = request.get("source", "output")
                    canvas_format = request.get("format", "ppt169")
                    if not project.is_dir():
                        raise ValueError("projectPath must be a directory")
                    if output.suffix.lower() != ".pptx":
                        raise ValueError("outputPath must end in .pptx")
                    if source not in {"output", "final"} or canvas_format not in {
                        "ppt169",
                        "ppt43",
                    }:
                        raise ValueError("PPT export options are invalid")
                    output.parent.mkdir(parents=True, exist_ok=True)
                    from svg_to_pptx import main as svg_to_pptx_main

                    exit_code = int(
                        svg_to_pptx_main(
                            [
                                str(project),
                                "--output",
                                str(output),
                                "--source",
                                source,
                                "--format",
                                canvas_format,
                                "--quiet",
                            ]
                        )
                        or 0
                    )
                elif operation == "ppt-master-quality-check":
                    project = bounded_ppt_path(
                        root, request.get("projectPath"), "projectPath", True
                    )
                    stage = request.get("stage", "final")
                    if stage not in {"first-page", "final"}:
                        raise ValueError("quality-check stage must be first-page or final")
                    module = load_script_module(
                        "workwise_svg_quality_checker",
                        scripts_root / "svg_quality_checker.py",
                    )
                    previous_argv = sys.argv
                    try:
                        sys.argv = [
                            str(scripts_root / "svg_quality_checker.py"),
                            str(project),
                            "--stage",
                            stage,
                            "--json",
                        ]
                        exit_code = int(module.main() or 0)
                    finally:
                        sys.argv = previous_argv
                    report_name = (
                        "svg_quality_report.json"
                        if stage == "final"
                        else "svg_quality_first_page_report.json"
                    )
                    report_path = project / "validation" / report_name
                    report: dict[str, Any] | None = None
                    if report_path.is_file():
                        try:
                            report = json.loads(report_path.read_text("utf-8"))
                        except Exception:
                            report = None
                    quality_check_payload = {
                        "exitCode": exit_code,
                        "reportPath": str(report_path.relative_to(root)),
                        "report": report,
                    }
                else:
                    raise ValueError("unsupported PPT Master operation")
        except SystemExit as error:
            raw_code = error.code
            exit_code = raw_code if isinstance(raw_code, int) else 1
    finally:
        try:
            sys.path.remove(str(scripts_root))
        except ValueError:
            pass

    if exit_code != 0 and operation != "ppt-master-quality-check":
        raise ValueError(
            (stderr.getvalue().strip() or stdout.getvalue().strip() or "PPT Master failed")[
                :1000
            ]
        )
    payload: dict[str, Any] = {
        "ok": True,
        "operation": operation,
        "stdout": stdout.getvalue().strip(),
        "warnings": [
            line.strip()
            for line in stderr.getvalue().splitlines()
            if line.strip()
        ][:50],
        "durationMs": int((time.monotonic() - started) * 1000),
    }
    if operation == "ppt-master-import-pptx":
        payload["outputDirectory"] = str(
            bounded_ppt_path(
                root, request.get("outputDirectory"), "outputDirectory", True
            ).relative_to(root)
        )
    elif operation == "ppt-master-export-pptx":
        payload["outputPath"] = str(
            bounded_ppt_path(root, request.get("outputPath"), "outputPath", True).relative_to(
                root
            )
        )
    if quality_check_payload is not None:
        payload.update(quality_check_payload)
    return payload


def headings(markdown: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for line in markdown.splitlines():
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match:
            result.append({"level": len(match.group(1)), "text": match.group(2)})
    return result[:2000]


def tables(markdown: str) -> list[dict[str, str]]:
    lines = markdown.splitlines()
    result: list[dict[str, str]] = []
    index = 0
    while index + 1 < len(lines):
        if "|" in lines[index] and re.match(r"^\s*\|?\s*:?-{3,}", lines[index + 1]):
            block = [lines[index], lines[index + 1]]
            index += 2
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                block.append(lines[index])
                index += 1
            result.append({"markdown": "\n".join(block)})
            if len(result) >= 500:
                break
            continue
        index += 1
    return result


def run(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("operation", "parse-document")
    if operation != "parse-document":
        if not isinstance(operation, str):
            raise ValueError("operation must be a string")
        return call_ppt_master(operation, request)

    started = time.monotonic()
    workspace = safe_path(request.get("workspaceRoot"), "workspaceRoot").resolve(strict=True)
    source = safe_path(request.get("inputPath"), "inputPath").resolve(strict=True)
    output = safe_path(request.get("outputDirectory"), "outputDirectory")
    if not workspace.is_dir():
        raise ValueError("workspaceRoot must be a directory")
    if not contained(workspace, source) or not contained(workspace, output):
        raise ValueError("input and output must stay within workspaceRoot")
    if not source.is_file() or source.is_symlink():
        raise ValueError("input must be a regular non-link file")
    if source.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError("unsupported document format")
    if source.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("document exceeds the 200 MiB limit")

    output.mkdir(parents=True, exist_ok=True)
    converter = MarkItDown(enable_plugins=False)
    # convert_local is deliberately used: the sidecar never accepts a URL and
    # never invokes MarkItDown's permissive remote conversion path.
    result = converter.convert_local(str(source))
    markdown = (result.text_content or "").replace("\r\n", "\n")
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    markdown_path = output / "document.md"
    markdown_path.write_text(markdown, encoding="utf-8", newline="\n")
    payload = {
        "ok": True,
        "engine": "markitdown",
        "engineVersion": ENGINE_VERSION,
        "sourceSha256": source_hash,
        "markdownPath": str(markdown_path.relative_to(workspace)),
        "headings": headings(markdown),
        "tables": tables(markdown),
        "media": [],
        "references": [],
        "warnings": [],
        "durationMs": int((time.monotonic() - started) * 1000),
    }
    (output / "result.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return payload


def main() -> int:
    # The bridge accepts exactly one bounded JSON request on stdin. Environment
    # proxy variables are removed as an additional network-denial safeguard.
    for name in list(os.environ):
        if name.lower().endswith("_proxy") or name.lower() == "no_proxy":
            os.environ.pop(name, None)
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("request exceeds 1 MiB")
    request = json.loads(raw.decode("utf-8"))
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    print(json.dumps(run(request), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # return a stable protocol error, not a traceback
        print(json.dumps({"ok": False, "code": "document_parse_failed", "message": str(error)}, ensure_ascii=True))
        raise SystemExit(2)
