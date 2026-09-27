#!/usr/bin/env python3
"""Read-only acceptance oracle for the three declared-reference inputs beside this script.

Uses stdlib/Fraction only; never imports product code. Raw SHA checks and numerical
comparisons are independent. Canonical JS model/record/storage hash verification
remains the Runtime's responsibility and is not claimed by this script.
"""
import argparse
from fractions import Fraction as F
from hashlib import sha256
import json
import math
from pathlib import Path
import sqlite3


def equal(actual, expected):
    if isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), (actual, expected)
        for a, e in zip(actual, expected):
            equal(a, e)
    else:
        assert isinstance(actual, (int, float)) and math.isfinite(actual)
        assert math.isclose(actual, float(expected), rel_tol=2e-12, abs_tol=2e-12), (actual, str(expected))


def verify(row, fixtures):
    record = json.loads(row['data_json'])
    raw = bytes(row['request_bytes'])
    declared = bytes(row['declaration_bytes'])
    request = json.loads(raw)
    assert raw.decode('utf-8') == record['requestJson']
    assert declared.decode('utf-8') == record['declarationJson'] == request['declarationJson']
    assert sha256(raw).hexdigest() == record['requestSha256'] == row['request_hash']
    assert sha256(declared).hexdigest() == record['declarationSha256']
    basis = record['modelBasisStatement'].encode('utf-8')
    assert sha256(basis).hexdigest() == record['modelBasisSha256']
    assert request['modelBasisStatement'] == record['modelBasisStatement']
    assert len(raw) == record['requestSizeBytes'] and len(declared) == record['declarationSizeBytes']
    assert len(basis) == record['modelBasisSizeBytes']
    for field, column in [('id', 'id'), ('projectId', 'project_id'), ('projectRevision', 'project_revision'),
                          ('projectBindingHash', 'project_binding_hash'), ('kind', 'kind'),
                          ('idempotencyKey', 'idempotency_key'), ('recordHash', 'record_hash'), ('createdAt', 'created_at')]:
        assert record[field] == row[column], field
    assert request['expectedProjectRevision'] == record['projectRevision']
    assert request['kind'] == record['kind'] and request['idempotencyKey'] == record['idempotencyKey']
    assert request['acknowledged'] is True and record['acknowledged'] is True
    assert record['formalResultsModified'] is False
    assert record['modelAssumptions'] == 'not-verified' and record['engineeringDecision'] == 'not-evaluated'
    original = json.loads(declared)
    name = next((name for name, fixture in fixtures.items() if fixture == original), None)
    assert name, 'Not one of the three acceptance declarations; no numeric claim made.'
    r = record['result']
    assert record['kind'] == 'reference-datum'
    assert record['pointCount'] == 3 and record['referenceCount'] == 2
    assert record['observationCount'] == record['parameterCount'] == 0
    assert r['sourceRecordsVerified'] is False and r['formalCoordinatesModified'] is False
    assert r['referencePhysicalStability'] == 'not-evaluated' and r['significanceTesting'] == 'not-performed'
    assert r['request'] == original
    if name == 'reference-singular-gls':
        assert r['outcome'] == 'unavailable' and r['code'] == 'reference-covariance-rank-or-conditioning'
        assert original['method'] == 'gls-reference-mean'
        assert 'displacements' not in r
    else:
        assert r['outcome'] == 'calculated'
        equal(r['referenceWeights'], [F(1,2),F(1,2),0])
        equal(r['rawDifferences'], [2,4,7])
        equal(r['referenceShift'],3)
        equal(r['displacements'],[-1,1,4])
        assert r['pointIds'] == ['a','b','c'] and r['referenceIds'] == ['a','b']
        if name == 'reference-gls':
            equal(r['referenceShiftVariance'],1)
            equal(r['differenceCovariance'],[[2,0,0],[0,2,0],[0,0,2]])
            equal(r['displacementCovariance'],[[1,-1,0],[-1,1,0],[0,0,3]])
            equal(r['shiftDisplacementCovariance'],[0,0,-1])
            assert r['covarianceCheck']['classification'] == 'numerically-positive-definite'
        else:
            assert name == 'reference-equal' and original['method'] == 'equal-reference-mean'
            equal(r['referenceShiftVariance'],0)
            equal(r['differenceCovariance'],[[2,-2,0],[-2,2,0],[0,0,2]])
            equal(r['displacementCovariance'],[[2,-2,0],[-2,2,0],[0,0,2]])
            equal(r['shiftDisplacementCovariance'],[0,0,0])
            assert r['covarianceCheck']['classification'] == 'semidefinite-or-unresolved-within-numerical-tolerance'
    return {'id': record['id'], 'fixture': name, 'requestSha256': record['requestSha256'],
            'declarationSha256': record['declarationSha256'], 'rawBindings': 'passed', 'independentNumerics': 'passed'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('database', type=Path)
    parser.add_argument('--project', required=True)
    args = parser.parse_args()
    fixtures = {p.stem: json.loads(p.read_text()) for p in (Path(__file__).parent / 'inputs').glob('*.json')}
    with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute('SELECT * FROM advanced_trials WHERE project_id=? ORDER BY created_at,id', (args.project,)).fetchall()
        assert len(rows) >= 3, 'Expected all three GUI-created trials.'
        results = [verify(row, fixtures) for row in rows]
        assert {r['fixture'] for r in results} == set(fixtures)
    print(json.dumps({'status': 'passed', 'projectId': args.project, 'count': len(results), 'records': results,
                      'scope': 'raw byte and SQL identity bindings plus independent acceptance arithmetic; not canonical hash replay or professional approval'}, indent=2))

if __name__ == '__main__':
    main()
