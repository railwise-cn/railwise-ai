#!/usr/bin/env python3
"""AI review: independent synthetic IN2/GSI numerical acceptance expectations."""

import csv
import hashlib
import json
import math
import platform
import re
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[4]
FIXTURES = ROOT / "kun/src/engineering/fixtures/survey-formats"


def source_identity(path):
    data = path.read_bytes()
    return {"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def dms_radians(token):
    value = Decimal(token)
    sign = -1 if value < 0 else 1
    value = abs(value)
    degree = int(value)
    fraction = (value - degree) * 100
    minute = int(fraction)
    second = (fraction - minute) * 100
    if not 0 <= minute < 60 or not 0 <= second < 60:
        raise ValueError("Invalid compact D.MMSS")
    return float(sign * (Decimal(degree) + Decimal(minute) / 60 + second / 3600)) * math.pi / 180


def wrapped(angle):
    return (angle + math.pi) % (2 * math.pi) - math.pi


def in2_expectations():
    path = FIXTURES / "cosa-in2/golden-plane-control-e2e.in2"
    rows = list(csv.reader(path.read_text(encoding="ascii").splitlines()))
    angle_arcsec, constant_mm, ppm = map(float, rows[0])
    controls = {}
    index = 1
    while len(rows[index]) == 3:
        name, north, east = rows[index]
        controls[name] = np.array([float(north), float(east)])
        index += 1
    station = rows[index][0]
    index += 1
    observations = []
    for row_number, row in enumerate(rows[index:], start=index + 1):
        target, kind, token = row
        value = dms_radians(token) if kind == "L" else float(token)
        sigma = angle_arcsec * math.pi / 648000 if kind == "L" else math.hypot(constant_mm / 1000, ppm * value / 1e6)
        observations.append({"line": row_number, "target": target, "kind": kind, "observed": value, "sigma": sigma, "unit": "rad" if kind == "L" else "m"})

    distances = [item for item in observations if item["kind"] == "S"]
    first, second = distances
    c1, c2 = controls[first["target"]], controls[second["target"]]
    d = np.linalg.norm(c2 - c1)
    along = (first["observed"] ** 2 - second["observed"] ** 2 + d * d) / (2 * d)
    perpendicular = math.sqrt(first["observed"] ** 2 - along * along)
    axis = (c2 - c1) / d
    normal = np.array([-axis[1], axis[0]])
    initial_candidates = [c1 + along * axis + sign * perpendicular * normal for sign in [-1, 1]]

    def model(parameters):
        predicted, design = [], []
        for item in observations:
            dx, dy = controls[item["target"]] - parameters[:2]
            r2 = dx * dx + dy * dy
            if item["kind"] == "L":
                predicted.append(wrapped(math.atan2(dy, dx) - parameters[2]))
                design.append([dy / r2, -dx / r2, -1.0])
            else:
                distance = math.sqrt(r2)
                predicted.append(distance)
                design.append([-dx / distance, -dy / distance, 0.0])
        return np.array(predicted), np.array(design)

    observed = np.array([item["observed"] for item in observations])
    sigmas = np.array([item["sigma"] for item in observations])

    def residual(parameters):
        predicted, design = model(parameters)
        values = predicted - observed
        for i, item in enumerate(observations):
            if item["kind"] == "L":
                values[i] = wrapped(values[i])
        return values, design

    backsight = next(item for item in observations if item["kind"] == "L")
    candidates = []
    for xy in initial_candidates:
        dx, dy = controls[backsight["target"]] - xy
        parameters = np.array([*xy, wrapped(math.atan2(dy, dx) - backsight["observed"])])
        values, _ = residual(parameters)
        candidates.append((float(np.dot(values / sigmas, values / sigmas)), parameters))
    initial = min(candidates, key=lambda item: item[0])[1]

    def solve(parameters):
        parameters = parameters.copy()
        steps = []
        for iteration in range(30):
            values, design = residual(parameters)
            delta, _, _, _ = np.linalg.lstsq(design / sigmas[:, None], -values / sigmas, rcond=None)
            parameters += delta
            steps.append({"iteration": iteration, "coordinateStepM": float(np.linalg.norm(delta[:2])), "orientationStepRad": float(abs(delta[2]))})
            if np.linalg.norm(delta[:2]) < 1e-11 and abs(delta[2]) < 1e-13:
                break
        else:
            raise AssertionError("Independent IN2 solver did not converge")
        return parameters, steps

    solution, steps = solve(initial)
    values, design = residual(solution)
    weighted_design = design / sigmas[:, None]
    _, singular_values, right = np.linalg.svd(weighted_design, full_matrices=False)
    rank = int(np.linalg.matrix_rank(weighted_design))
    prior = (right.T / singular_values ** 2) @ right
    dof = len(observations) - rank
    sse = float(np.dot(values / sigmas, values / sigmas))
    variance_factor = sse / dof
    posterior = variance_factor * prior

    def ellipse(covariance):
        eigenvalues, eigenvectors = np.linalg.eigh(covariance[:2, :2])
        major = eigenvectors[:, -1]
        return {"semiMajorM": float(math.sqrt(eigenvalues[-1])), "semiMinorM": float(math.sqrt(eigenvalues[0])), "orientationRad": float(math.atan2(major[1], major[0]) % math.pi), "orientationConvention": "positive X toward positive Y modulo pi; one-sigma axes"}

    finite_difference = np.zeros_like(design)
    for parameter, step in enumerate([1e-3, 1e-3, 1e-5]):
        delta = np.zeros(3)
        delta[parameter] = step
        before = model(solution - delta)[0]
        after = model(solution + delta)[0]
        difference = after - before
        for i, item in enumerate(observations):
            if item["kind"] == "L":
                difference[i] = wrapped(difference[i])
        finite_difference[:, parameter] = difference / (2 * step)
    jacobian_error = float(np.max(np.abs(design - finite_difference)))
    assert jacobian_error < 1e-8
    restarts = [solve(np.array([49, 51, math.pi / 2]))[0], solve(np.array([51, 49, math.pi / 2]))[0], solve(np.array([50, 50, math.pi / 2]))[0]]
    spread = np.ptp(np.vstack([solution, *restarts]), axis=0)
    assert max(spread) < 1e-10
    assert rank == 3 and dof == 2
    assert all(abs(float(x)) < 1e-6 for x in solution[:2] - 50)
    for item, value in zip(observations, values):
        item["adjustedMinusObserved"] = float(value)
        item["observedMinusAdjusted"] = float(-value)
        item["residualOverDeclaredPriorSigma"] = float(value / item["sigma"])

    return {"source": source_identity(path), "coordinateConvention": "X north, Y east; azimuth atan2(dY,dX), clockwise from north", "fixedControlsM": {name: value.tolist() for name, value in controls.items()}, "station": station, "initialParameters": initial.tolist(), "finalParameters": solution.tolist(), "independentInitialCorrection": (solution - initial).tolist(), "parameterUnits": ["m", "m", "rad"], "observations": observations, "observationCount": len(observations), "parameterCount": 3, "rank": rank, "degreesOfFreedom": dof, "weightedSSE": sse, "varianceFactor": variance_factor, "unitWeightStdDev": math.sqrt(variance_factor), "varianceFactorUnit": "dimensionless with explicit absolute prior sigmas", "aprioriCovariance": prior.tolist(), "posteriorCovariance": posterior.tolist(), "covarianceUnitsByEntry": [["m2", "m2", "m rad"], ["m2", "m2", "m rad"], ["m rad", "m rad", "rad2"]], "aprioriPointStdDevM": float(math.sqrt(prior[0, 0] + prior[1, 1])), "posteriorPointStdDevM": float(math.sqrt(posterior[0, 0] + posterior[1, 1])), "aprioriEllipse": ellipse(prior), "posteriorEllipse": ellipse(posterior), "linearResidualNormM": float(np.linalg.norm([value for item, value in zip(observations, values) if item["kind"] == "S"])), "angularResidualNormRad": float(np.linalg.norm([value for item, value in zip(observations, values) if item["kind"] == "L"])), "independentClosure": "not-evaluated; residual norms are descriptive only", "selfchecks": {"analyticJacobianMaximumDifference": jacobian_error, "multipleStartSolutionSpread": spread.tolist(), "iterations": steps}}


def ftext(value):
    return str(value.numerator) if value.denominator == 1 else f"{value.numerator}/{value.denominator}"


def rational_matrix_inverse(matrix):
    size = len(matrix)
    work = [[Fraction(value) for value in row] + [Fraction(i == j) for j in range(size)] for i, row in enumerate(matrix)]
    for i in range(size):
        pivot = next(j for j in range(i, size) if work[j][i])
        work[i], work[pivot] = work[pivot], work[i]
        factor = work[i][i]
        work[i] = [value / factor for value in work[i]]
        for j in range(size):
            if j != i:
                factor = work[j][i]
                work[j] = [value - factor * pvalue for value, pvalue in zip(work[j], work[i])]
    return [row[size:] for row in work]


def gsi_expectations():
    path = FIXTURES / "professional/leica-gsi-cumulative-leveling.gsi"
    records = []
    for line, text in enumerate(path.read_text(encoding="ascii").splitlines(), start=1):
        if text.startswith("41"):
            continue
        words = text.split()
        point = re.fullmatch(r"11[0-9]{4}([+-])(.{8})", words[0])
        assert point and point.group(1) == "+"
        name = point.group(2).lstrip("0") or "0"
        height = None
        distance = None
        for word in words[1:]:
            match = re.fullmatch(r"(83..[025]8|574..8)([+-])([0-9]{8})", word)
            assert match, f"Unexpected synthetic word: {word}"
            value = Fraction(int(match.group(3)) * (-1 if match.group(2) == "-" else 1), 100000)
            if match.group(1).startswith("83"):
                height = value
            else:
                distance = value
        assert height is not None
        records.append({"line": line, "point": name, "cumulativeHeight": height, "cumulativeDistance": distance})
    known = Fraction(100)
    assert records[0]["point"] == records[-1]["point"] == "BM" and records[0]["cumulativeHeight"] == known
    lengths, observed, previous_height, previous_distance = [], [], records[0]["cumulativeHeight"], Fraction(0)
    for item in records[1:]:
        lengths.append(item["cumulativeDistance"] - previous_distance)
        observed.append(item["cumulativeHeight"] - previous_height)
        previous_height, previous_distance = item["cumulativeHeight"], item["cumulativeDistance"]
    assert lengths == [100, 200, 200, 100]
    closure = sum(observed, Fraction(0))
    total_length = sum(lengths, Fraction(0))
    correction = [-closure * length / total_length for length in lengths]
    adjusted = [value + v for value, v in zip(observed, correction)]
    heights, height = [], known
    for difference in adjusted[:-1]:
        height += difference
        heights.append(height)
    assert height + adjusted[-1] == known
    design = [[1, 0, 0], [-1, 1, 0], [0, -1, 1], [0, 0, -1]]
    weights = [1 / length for length in lengths]
    normal = [[sum(Fraction(design[k][i] * design[k][j]) * weights[k] for k in range(4)) for j in range(3)] for i in range(3)]
    cofactor = rational_matrix_inverse(normal)
    sse = sum(v * v * weight for v, weight in zip(correction, weights))
    posterior = [[sse * value for value in row] for row in cofactor]
    # A second, floating-point least-squares solve checks the exact fractions.
    right = np.array([float(observed[0] + known), float(observed[1]), float(observed[2]), float(observed[3] - known)])
    root_weights = np.sqrt(np.array([float(weight) for weight in weights]))
    ls_heights, _, rank, _ = np.linalg.lstsq(np.array(design) * root_weights[:, None], right * root_weights, rcond=None)
    assert rank == 3
    assert np.max(np.abs(ls_heights - np.array([float(value) for value in heights]))) < 1e-12
    assert closure == Fraction(1, 2500) and sse == Fraction(1, 3750000000)
    return {"source": source_identity(path), "knownDatum": {"point": "BM", "heightM": 100, "status": "synthetic declared fixed datum, not independently authenticated"}, "weightConvention": "relative P=diag(L0/L), L0=1 m; equivalent numeric 1/L_numeric_metres, no absolute per-observation sigma supplied", "routeLengthM": [float(value) for value in lengths], "totalLengthM": float(total_length), "observationCount": 4, "parameterCount": 3, "rank": int(rank), "degreesOfFreedom": 1, "closureM": float(closure), "closureExactM": ftext(closure), "closureMm": float(closure * 1000), "closureTolerance": None, "closureEvaluation": "not-evaluated", "heightObservationsM": [float(value) for value in observed], "correctionsAdjustedMinusObservedM": [float(value) for value in correction], "correctionsExactM": [ftext(value) for value in correction], "finalPointIds": ["gsi-block-1:Z01", "P1", "gsi-block-1:Z02"], "finalHeightsM": [float(value) for value in heights], "finalHeightsExactM": [ftext(value) for value in heights], "weightedSSEUnderDeclaredNormalization": float(sse), "posteriorVarianceFactorUnderDeclaredNormalization": float(sse), "varianceFactorUnitUnderDeclaredNormalization": "m2", "varianceFactorExact": ftext(sse), "unitWeightStdDevUnderDeclaredNormalization": math.sqrt(float(sse)), "unitWeightStdDevUnitUnderDeclaredNormalization": "m", "cofactorUnderDeclaredNormalization": [[float(value) for value in row] for row in cofactor], "cofactorUnitUnderDeclaredNormalization": "dimensionless", "cofactorExact": [[ftext(value) for value in row] for row in cofactor], "posteriorCovarianceM2": [[float(value) for value in row] for row in posterior], "posteriorStandardErrorsM": [math.sqrt(float(posterior[i][i])) for i in range(3)], "absoluteAprioriPrecision": "not available from relative route-length weights alone", "normalizationBoundary": "Changing common relative-weight C rescales variance factor and cofactor inversely; posterior covariance is invariant. Numerical product labels for variance factor must not be interpreted as a calibrated instrument precision.", "reviewStatus": "unsigned", "standardsConformity": "not-evaluated"}


def main():
    assert dms_radians("270.00000") == 3 * math.pi / 2
    assert dms_radians("315.00000") == 7 * math.pi / 4
    for token in ["12.60000", "12.00600", "-12.00600"]:
        try:
            dms_radians(token)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid DMS accepted")
    report = {"status": "independent-synthetic-expectations; not packaged acceptance", "reviewType": "AI review", "productParserOrSolverImported": False, "pythonVersion": platform.python_version(), "numpyVersion": np.__version__, "in2": in2_expectations(), "gsi": gsi_expectations()}
    print(json.dumps(report, ensure_ascii=True, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
