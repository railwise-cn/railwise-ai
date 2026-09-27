#!/usr/bin/env python3
"""Read-only, de-identified audit of explicit GSI/IN1/package evidence inputs.

This diagnostic supports GSI8 WI41 leveling blocks using unit code 8 and
BFFB readings 331/332/336/335. It does not change the application parser,
infer instrument corrections, authenticate a converter, or sign acceptance.
"""
import argparse
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

# Importing the existing numerical checker must not create a bytecode cache.
sys.dont_write_bytecode = True
import numpy as np

D = Decimal


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def scalar(word):
    if len(word) != 15 or word[5] != '8' or not re.fullmatch(r'[+-]\d{8}', word[6:]):
        raise ValueError('unsupported scalar encoding')
    return D(word[6:]) / 100000


def one(words, prefix):
    matches = [word for word in words if word.startswith(prefix)]
    if len(matches) != 1:
        raise ValueError('missing or duplicate source field')
    return matches[0]


def point_id(words):
    word = one(words, '11')
    if len(word) != 15 or word[6] != '+' or not re.fullmatch(r'[A-Za-z0-9_-]{8}', word[7:]):
        raise ValueError('unsupported source identifier')
    return word[7:].lstrip('0') or '0'


def parse_source(raw):
    block = 0
    block_edges = 0
    previous = None
    readings = {}
    distances = []
    edges = []
    for line_no, line in enumerate(raw.decode('ascii').splitlines(), 1):
        words = line.split()
        if not words:
            continue
        if any(word.startswith('41') for word in words):
            if readings or distances or (block and not block_edges):
                raise ValueError('incomplete preceding setup')
            block += 1
            block_edges = 0
            previous = None
            continue
        if not block:
            raise ValueError('source does not start with WI41')
        for word in words:
            if word.startswith('33'):
                code = word[:3]
                if word[:6] not in ('331.08', '332.08', '335.08', '336.08') or code in readings:
                    raise ValueError('unsupported or duplicate BFFB field')
                readings[code] = scalar(word)
            if word.startswith('32'):
                if word[:6] != '32...8':
                    raise ValueError('unsupported distance field')
                distances.append(scalar(word))
        height_words = [word for word in words if word.startswith('83')]
        if not height_words:
            continue
        if len(height_words) != 1:
            raise ValueError('duplicate height field')
        height_word = height_words[0]
        if height_word[:6] in ('83..58', '83..18'):
            if previous is not None or readings or distances:
                raise ValueError('unexpected height initialization')
            previous = (point_id(words), scalar(height_word), D(0))
            continue
        if height_word[:6] != '83..08' or previous is None:
            raise ValueError('unsupported final-height field or missing initialization')
        if set(readings) != {'331', '332', '335', '336'} or len(distances) != 4:
            raise ValueError('incomplete BFFB observations')
        point = point_id(words)
        target = f'gsi-block-{block}:{point.upper()}' if re.fullmatch(r'Z0[12]', point, re.I) else point
        height = scalar(height_word)
        distance = scalar(one(words, '574..8'))
        if target == previous[0] or distance <= previous[2]:
            raise ValueError('unsupported self-edge or non-increasing distance')
        edges.append({
            'block': block, 'line': line_no, 'from': previous[0], 'to': target,
            'height': height - previous[1], 'distance': distance - previous[2],
            'mean': (readings['331'] - readings['332'] + readings['335'] - readings['336']) / 2,
            'meanDistance': sum(distances) / 2,
        })
        previous = (target, height, distance)
        block_edges += 1
        readings = {}
        distances = []
    if readings or distances or not edges or not block_edges:
        raise ValueError('truncated or empty source')
    return edges


def decimal(value):
    result = D(str(value))
    if not result.is_finite():
        raise ValueError('non-finite input')
    return result


def parse_reference(raw):
    rows = []
    for line_no, line in enumerate(raw.decode('gb18030').splitlines(), 1):
        if not line.strip():
            continue
        fields = [field.strip() for field in line.split(',')]
        if len(fields) != 4 or not fields[0] or not fields[1] or fields[0] == fields[1]:
            raise ValueError('invalid reference row')
        height, kilometres = decimal(fields[2]), decimal(fields[3])
        if kilometres <= 0:
            raise ValueError('non-positive reference length')
        rows.append({'line': line_no, 'from': fields[0], 'to': fields[1], 'height': height,
                     'distance': kilometres * 1000,
                     'heightQuantum': D(10) ** height.as_tuple().exponent,
                     'distanceQuantum': D(10) ** kilometres.as_tuple().exponent * 1000})
    if not rows:
        raise ValueError('empty reference')
    return rows


def rounded_to(value, quantum):
    return (value / quantum).quantize(D(1), rounding=ROUND_HALF_UP) * quantum


def self_check():
    assert scalar('83..08-00000001') == D('-0.00001')
    assert rounded_to(D('10.48629'), D(1)) == D(10)
    assert rounded_to(D('10.50001'), D(1)) != D(10)
    assert abs(D('0.00002')) > D('0.00001') / 2
    fixture = b'\n'.join([
        b'410001+?......4', b'110002+0000000A 83..58+00000000',
        b'32...8+00100000 331.08+00150000', b'32...8+00100000 332.08+00100000',
        b'32...8+00100000 336.08+00100000', b'32...8+00100000 335.08+00150000',
        b'110007+0000000B 574..8+00200000 83..08+00050000',
    ])
    parsed = parse_source(fixture)
    assert len(parsed) == 1 and parsed[0]['height'] == D('0.5') and parsed[0]['distance'] == D(2)
    for malformed in [fixture + b'\n410001+?......4', fixture.replace(b'331.08', b'331.06'), fixture.rsplit(b'\n', 1)[0]]:
        try:
            parse_source(malformed)
        except ValueError:
            continue
        raise AssertionError('unsupported or truncated source accepted')
    for word in ['83..06+00000001', '83..08+00000NaN', '83..08+000000001']:
        try:
            scalar(word)
        except ValueError:
            continue
        raise AssertionError('invalid source scalar accepted')
    try:
        parse_reference(b'A,B,NaN,0.001')
    except ValueError:
        return
    raise AssertionError('non-finite reference accepted')


def audit(args):
    self_check()
    actual = json.loads(args.actual.read_text())
    if not isinstance(actual.get('packageAsarSha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', actual['packageAsarSha256']):
        raise ValueError('invalid package provenance hash')
    source_bytes = args.source.read_bytes()
    reference_bytes = args.reference_in1.read_bytes()
    known_bytes = args.known_points.read_bytes()
    if actual['sourceSha256'] != sha256(source_bytes) or actual['knownPointsSha256'] != sha256(known_bytes):
        raise ValueError('source or controls do not match package evidence')
    edges = parse_source(source_bytes)
    reference = parse_reference(reference_bytes)
    observations = actual['observations']
    if len(observations) != len(edges):
        raise ValueError('source and package observation counts differ')
    height_errors, distance_errors = [], []
    for edge, observation in zip(edges, observations):
        if (edge['from'], edge['to']) != (observation['from'], observation['to']):
            raise ValueError('source and package observation ordering differs')
        height_errors.append(abs(edge['height'] - decimal(observation['value'])))
        distance_errors.append(abs(edge['distance'] - decimal(observation['routeLength'])))
    endpoints = {row[point] for row in reference for point in ('from', 'to')}
    reduced, pending = [], []
    for edge in edges:
        if pending and (pending[-1]['to'] != edge['from'] or pending[-1]['block'] != edge['block']):
            raise ValueError('source chain is discontinuous')
        pending.append(edge)
        if edge['to'] in endpoints:
            reduced.append({'from': pending[0]['from'], 'to': edge['to'],
                            'lines': [item['line'] for item in pending],
                            **{key: sum(item[key] for item in pending) for key in ['height', 'distance', 'mean', 'meanDistance']}})
            pending = []
    if pending or len(reduced) != len(reference):
        raise ValueError('route coverage differs')
    route_report = []
    for source, ref in zip(reduced, reference):
        if (source['from'], source['to']) != (ref['from'], ref['to']):
            raise ValueError('reference endpoints or route order differ')
        dh, dd, mean_dh = source['height'] - ref['height'], source['distance'] - ref['distance'], source['mean'] - ref['height']
        route_report.append({
            'referenceLine': ref['line'], 'sourceFinalLines': source['lines'],
            'cumulativeHeightMinusReferenceMm': float(dh * 1000),
            'rawReadingsMeanMinusReferenceMm': float(mean_dh * 1000),
            'heightHalfPrintedUnitMm': float(ref['heightQuantum'] * 1000 / 2),
            'distanceMinusReferenceMetres': float(dd),
            'distanceHalfPrintedUnitMetres': float(ref['distanceQuantum'] / 2),
            'heightBeyondHalfPrintedUnit': abs(dh) > ref['heightQuantum'] / 2,
            'rawMeanBeyondHalfPrintedUnit': abs(mean_dh) > ref['heightQuantum'] / 2,
            'distanceRoundedToPrintedUnitMatches': rounded_to(source['distance'], ref['distanceQuantum']) == ref['distance'],
        })
    known = {}
    for line in known_bytes.decode('gb18030').splitlines():
        if not line.strip():
            continue
        fields = line.replace(',', ' ').split()
        if len(fields) != 2 or fields[0] in known:
            raise ValueError('invalid or duplicate control')
        known[fields[0]] = float(decimal(fields[1]))
    actual_points = {point['id']: float(decimal(point['height'])) for point in actual['points']}
    if len(actual_points) != len(actual['points']):
        raise ValueError('duplicate package point identity')
    if any(point not in actual_points or abs(actual_points[point] - height) > 1e-9 for point, height in known.items()):
        raise ValueError('package control mismatch')
    checker_path = Path(__file__).with_name('check-gsi-leveling-reference.py')
    spec = importlib.util.spec_from_file_location('independent_gsi_numerics', checker_path)
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    checker.self_check()
    numeric_rows = lambda rows: [(row['from'], row['to'], float(row['height']), float(row['distance'])) for row in rows]
    ids, heights, _, dof = checker.solve(numeric_rows(edges), known)
    if dof != actual['degreesOfFreedom']:
        raise ValueError('package redundancy mismatch')
    full_max = max(abs(float(value) - actual_points[point]) * 1000 for point, value in zip(ids, heights))
    base_ids, base_values, _, _ = checker.solve(numeric_rows(reduced), known)
    base_points = dict(zip(base_ids, base_values))
    variants = {'sameSourceReduced': reduced, 'referenceBoth': reference}
    for label, field in [('referenceHeightOnly', 'height'), ('referenceDistanceOnly', 'distance')]:
        variants[label] = [{**source, field: ref[field]} for source, ref in zip(reduced, reference)]
    numeric_report = {}
    for label, rows in variants.items():
        point_ids, values, _, _ = checker.solve(numeric_rows(rows), known)
        numeric_report[label] = {
            'maximumVsPackagedMm': max(abs(float(value) - actual_points[point]) * 1000 for point, value in zip(point_ids, values)),
            'maximumVsSameSourceReferenceMm': max(abs(float(value) - base_points[point]) * 1000 for point, value in zip(point_ids, values)),
        }
    return {
        'schemaVersion': 1, 'scope': 'source-discrepancy-audit-not-professional-acceptance', 'numpyVersion': np.__version__,
        'sourceCoverage': 'GSI8-WI41-unit8-BFFB-331-332-336-335-final-WI83..08',
        'hashes': {'checkerSha256': sha256(Path(__file__).read_bytes()), 'numericalCheckerSha256': sha256(checker_path.read_bytes()),
                   'sourceSha256': sha256(source_bytes), 'referenceIn1Sha256': sha256(reference_bytes),
                   'knownPointsSha256': sha256(known_bytes), 'actualEvidenceSha256': sha256(args.actual.read_bytes()),
                   'packageAsarSha256': actual.get('packageAsarSha256')},
        'rawSourceToPackaged': {'observationCount': len(edges), 'maximumHeightDifferenceMetres': float(max(height_errors)),
                                'maximumDistanceDifferenceMetres': float(max(distance_errors))},
        'referenceConversion': {'routeCount': len(reference),
            'heightBeyondHalfPrintedUnitCount': sum(row['heightBeyondHalfPrintedUnit'] for row in route_report),
            'rawMeanBeyondHalfPrintedUnitCount': sum(row['rawMeanBeyondHalfPrintedUnit'] for row in route_report),
            'distanceRoundedToPrintedUnitMatchCount': sum(row['distanceRoundedToPrintedUnitMatches'] for row in route_report),
            'maximumDistanceDifferenceMetres': max(abs(row['distanceMinusReferenceMetres']) for row in route_report),
            'heightConversionProvenance': 'unresolved', 'routes': route_report},
        'sameSourceIndependentAdjustment': {'unknownPointCount': len(ids), 'degreesOfFreedom': dof,
            'maximumVsPackagedMm': full_max},
        'referenceInputVariants': numeric_report, 'selfCheck': 'passed',
        'interpretationBoundary': 'Printed-unit comparisons are representation checks, not normative accuracy limits. No source/converter identity, correction policy, evidence authenticity or professional sign-off is inferred.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ['actual', 'source', 'reference-in1', 'known-points']:
        parser.add_argument('--' + option, type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(audit(args), indent=2, ensure_ascii=False, allow_nan=False))
    except (OSError, UnicodeError, ValueError, TypeError, KeyError, IndexError, AttributeError,
            OverflowError, InvalidOperation, AssertionError, np.linalg.LinAlgError):
        print(json.dumps({'status': 'failed', 'reason': 'Input unavailable, unsupported, inconsistent, non-finite or numerically invalid; no raw data emitted.'}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
