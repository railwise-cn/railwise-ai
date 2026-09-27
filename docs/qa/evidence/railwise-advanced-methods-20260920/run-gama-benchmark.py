#!/usr/bin/env python3
"""Run independent GNU Gama fixtures; no WorkWise solver is imported."""

import argparse
import hashlib
import json
import math
import platform
import shutil
import subprocess
import sys
import tarfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f"{args}: exit {result.returncode}: {result.stderr}")
    return result.stdout


def near(actual, expected, tolerance):
    if not math.isfinite(actual) or abs(actual - expected) > tolerance:
        raise AssertionError(f"{actual} != {expected} (tolerance {tolerance})")
    return abs(actual - expected)


def compare(data, xml_path, translation):
    expected_heights = {"A": -37 / 30, "B": -1 / 3, "C": 47 / 30}
    signs = {("A", "B"): 1, ("B", "C"): 1, ("C", "A"): 1, ("B", "A"): -1}
    assert data["version"] == "2.29"
    assert data["degreesOfFreedom"] == data["defect"] == 1
    assert data["unknownCount"] == data["observationCount"] == 3
    assert data["aprioriScale"] == 1
    assert len(data["points"]) == 3
    assert {p["id"] for p in data["points"]} == set(expected_heights)
    assert len(data["observations"]) == 3
    assert len({(o["from"], o["to"]) for o in data["observations"]}) == 3
    height_error = max(near(p["heightM"], expected_heights[p["id"]] + translation, 1e-10)
                       for p in data["points"])
    residual_error = max(near(o["residualObservedMinusAdjustedM"], signs[o["from"], o["to"]] / 10, 1e-10)
                         for o in data["observations"])
    height_cov_error = max(near(data["heightCofactorM2"][i][j], (2 if i == j else -1) / 9, 1e-10)
                           for i in range(3) for j in range(3))
    residual_signs = [signs[o["from"], o["to"]] for o in data["observations"]]
    residual_cov_error = max(near(data["residualCofactorM2"][i][j], residual_signs[i] * residual_signs[j] / 3, 1e-10)
                             for i in range(3) for j in range(3))
    sse_error = near(data["weightedSSE"], 0.03, 1e-12)
    by_id = {p["id"]: p["heightM"] for p in data["points"]}
    height_diff_error = max(near(by_id[b] - by_id[a], value, 1e-10)
                            for a, b, value in [("A", "B", 0.9), ("B", "C", 1.9), ("C", "A", -2.8)])
    near(sum(by_id.values()), 3 * translation, 1e-10)
    point_indexes = {p["id"]: i for i, p in enumerate(data["points"])}
    a, b = point_indexes["A"], point_indexes["B"]
    q = data["heightCofactorM2"]
    contrast_error = near(q[a][a] + q[b][b] - q[a][b] - q[b][a], 2 / 3, 1e-10)

    root = ET.parse(xml_path).getroot()
    for element in root.iter():
        element.tag = element.tag.split("}")[-1]
    assert root.tag == "gama-local-adjustment"
    parameters = root.find("network-general-parameters")
    assert parameters.get("gama-local-version") == "2.29"
    assert parameters.get("gama-local-algorithm") == data["algorithm"]
    equations = root.find("network-processing-summary/project-equations")
    assert int(equations.findtext("degrees-of-freedom")) == 1
    assert int(equations.findtext("defect")) == 1
    assert int(equations.findtext("equations")) == 3
    assert int(equations.findtext("unknowns")) == 3
    assert equations.find("connected-network") is not None
    assert root.findtext("network-processing-summary/standard-deviation/used") == "apriori"
    cli_points = root.findall("coordinates/adjusted/point")
    assert len(cli_points) == 3, "CLI must contain all three adjusted points"
    assert {p.findtext("id") for p in cli_points} == set(by_id), "CLI adjusted point IDs must match probe"
    for p in cli_points:
        near(float(p.findtext("Z")), by_id[p.findtext("id")], 1e-10)
    observed = {(o["from"], o["to"]): o for o in data["observations"]}
    cli_observations = root.findall("observations/height-diff")
    assert len(cli_observations) == 3, "CLI must contain all three height differences"
    assert {(o.findtext("from"), o.findtext("to")) for o in cli_observations} == set(observed), "CLI observation IDs must match probe"
    for o in cli_observations:
        probe = observed[o.findtext("from"), o.findtext("to")]
        near(float(o.findtext("obs")) - float(o.findtext("adj")), probe["residualObservedMinusAdjustedM"], 1e-10)
    matrix = root.find("coordinates/cov-mat")
    assert int(matrix.findtext("dim")) == 3 and int(matrix.findtext("band")) == 2
    # XML uses 8 significant digits, so compare with its half-unit rounding bound.
    xml_cov_error = max(near(float(v.text) / 1e6, data["heightCofactorM2"][i][j], 5e-9)
                        for (i, j), v in zip(((i, j) for i in range(3) for j in range(i, 3)), matrix.findall("flt"), strict=True))
    return {
        "heightMaxAbsErrorM": height_error,
        "heightDifferenceMaxAbsErrorM": height_diff_error,
        "residualMaxAbsErrorM": residual_error,
        "heightCofactorMaxAbsErrorM2": height_cov_error,
        "residualCofactorMaxAbsErrorM2": residual_cov_error,
        "heightContrastCofactorAbsErrorM2": contrast_error,
        "weightedSSEAbsError": sse_error,
        "cliVsProbeCovarianceMaxAbsErrorM2": xml_cov_error,
        "cliCovarianceRoundingToleranceM2": 5e-9,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--probe", required=True, type=Path)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--build-log-dir", required=True, type=Path)
    args = parser.parse_args()
    evidence = Path(__file__).resolve().parent
    output = evidence / "gama-outputs"
    output.mkdir(exist_ok=True)
    report = {
        "schemaVersion": 1,
        "scope": "Independent Gama numerical benchmark only; product free-network method not implemented",
        "status": "running",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "macOS": command(["sw_vers"]),
        "compiler": command(["clang++", "--version"]),
        "version": command([str(args.binary), "--version"]),
        "sourceArchiveSha256": digest(args.archive),
        "binarySha256": digest(args.binary),
        "probeBinarySha256": digest(args.probe),
        "probeSourceSha256": digest(evidence / "gama-precision-probe.cpp"),
        "checkerSourceSha256": digest(__file__),
        "comparatorTestSourceSha256": digest(evidence / "test-gama-benchmark.py"),
        "systemInstallPerformed": False,
        "sourceCodeModified": False,
        "gpgSignatureVerified": False,
        "buildFlags": "-O2 -std=c++17 -include sstream",
        "buildCommands": [
            "./configure --prefix=" + str(args.source_root.parent / "local") + " --disable-gama-g3 CXX=clang++ CC=clang CXXFLAGS='-O2 -std=c++17 -include sstream'",
            "make -C lib -j4",
            "make -C src gama-local -j4",
            "clang++ -O2 -std=c++17 -include sstream -I " + str(args.source_root / "lib") + " " + str(evidence / "gama-precision-probe.cpp") + " " + str(args.source_root / "lib/libgama.a") + " -lsqlite3 -lexpat -o " + str(args.probe),
        ],
        "resolvedSetupFailures": [
            "Initial curl archive download timed out after 60 seconds; retry was stopped; Node fetch completed and matched the pinned archive hash.",
            "Initial stock build failed because deformation.cpp relies on indirect sstream inclusion; compiler flag -include sstream resolved it without changing source files.",
            "Initial evidence adapter treated qbb as an unwhitened cofactor; analytical Qvv check exposed the unit error. Corrected conversion using sqrt(weight_i*weight_j), consistent with Gama network.cpp's residual cofactor formula.",
        ],
        "cases": [],
    }
    try:
        assert report["sourceArchiveSha256"] == "c00fa3c6fff4e777834dfae02afccff2e14884f544f5ac752a0047d56e80b411"
        source_count = 0
        with tarfile.open(args.archive) as archive:
            for member in archive.getmembers():
                if member.isfile() and member.name.endswith((".h", ".cpp", ".c", ".cc")):
                    relative = Path(member.name).relative_to("gama-2.29")
                    expected = hashlib.sha256(archive.extractfile(member).read()).hexdigest()
                    assert digest(args.source_root / relative) == expected, str(relative)
                    source_count += 1
        report["unchangedSourceFilesChecked"] = source_count
        for case in ["free-leveling-001", "free-leveling-translated", "free-leveling-reordered-reversed"]:
            fixture = evidence / "gama-inputs" / f"{case}.xml"
            translation = 1234.5 if case == "free-leveling-translated" else 0
            for algorithm in ["svd", "gso"]:
                name = f"{case}-{algorithm}"
                xml_path = output / f"{name}.xml"
                text_path = output / f"{name}.txt"
                probe_path = output / f"{name}.json"
                cli_command = [str(args.binary), str(fixture), "--algorithm", algorithm, "--iterations", "0", "--cov-band", "-1", "--xml", str(xml_path), "--text", str(text_path)]
                probe_command = [str(args.probe), str(fixture), algorithm]
                command(cli_command)
                raw = command(probe_command)
                probe_path.write_text(raw, encoding="utf-8")
                data = json.loads(raw)
                assert data["algorithm"] == algorithm
                entry = {
                    "id": name,
                    "cliCommand": cli_command,
                    "probeCommand": probe_command,
                    "fixtureSha256": digest(fixture),
                    "outputXmlSha256": digest(xml_path),
                    "outputTextSha256": digest(text_path),
                    "outputProbeSha256": digest(probe_path),
                    "status": "passed",
                    "degreesOfFreedom": data["degreesOfFreedom"],
                    "datumDefect": data["defect"],
                    "weightedSSE": data["weightedSSE"],
                    "differences": compare(data, xml_path, translation),
                }
                report["cases"].append(entry)
        report["status"] = "passed"
        test_command = [sys.executable, "-B", str(evidence / "test-gama-benchmark.py")]
        command(test_command)
        report["comparatorTests"] = {"status": "passed", "command": test_command, "scope": "One complete archived XML and seven malformed-result test cases"}
    except Exception as error:
        report["status"] = "failed"
        report["failure"] = str(error)
    logs = evidence / "gama-build-logs"
    logs.mkdir(exist_ok=True)
    report["buildLogs"] = []
    for name in ["configure.log", "build-lib.log", "configure-compatible.log", "build-lib-compatible.log", "build-cli.log"]:
        original = args.build_log_dir / name
        if original.exists():
            retained_name = Path(name).with_suffix(".txt").name
            shutil.copyfile(original, logs / retained_name)
            report["buildLogs"].append({"path": f"gama-build-logs/{retained_name}", "sha256": digest(logs / retained_name)})
    report["completedAt"] = datetime.now(timezone.utc).isoformat()
    (evidence / "gama-benchmark.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "cases": len(report["cases"]), "failure": report.get("failure")}, ensure_ascii=False))
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
