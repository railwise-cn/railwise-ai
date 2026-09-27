#!/usr/bin/env python3
"""Read-only acceptance oracle for the three explicit inputs beside this script.

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
    if name == 'w-diagonal':
        assert r['modelStatus'] == 'resolved'
        weights = [F(1), F(1, 2), F(1, 3)]
        mean = sum(w * y for w, y in zip(weights, [1, 2, 3])) / sum(weights)
        residuals = [F(y) - mean for y in [1, 2, 3]]
        equal(r['parameters'], [mean]); equal(r['residuals'], residuals)
        equal(r['aprioriWeightedResidualSum'], sum(w * v * v for w, v in zip(weights, residuals)))
        equal(r['residualCovariance'], [[F(i + 1 if i == j else 0) - 1 / sum(weights) for j in range(3)] for i in range(3)])
        directions = {d['id']: d for d in r['diagnostics']}
        equal(directions['first-observation']['generalizedW'], -7 / math.sqrt(55))
        assert directions['common-mode']['status'] == 'not-detectable-or-numerically-unresolved'
        assert directions['common-mode']['generalizedW'] is None
    elif name == 'vce-single-group':
        assert r['outcome'] == 'converged'
        y = [F(n) for n in [1, 2, 4, 5]]
        mean = sum(y) / len(y); residuals = [v - mean for v in y]
        variance = sum(v * v for v in residuals) / (len(y) - 1)
        equal(r['convergedVariances'], [variance])
        equal(r['finalFit']['parameters'], [mean]); equal(r['finalFit']['residuals'], residuals)
        assert len(r['iterations']) == 2
        for step in r['iterations']:
            equal(step['candidateVariances'], [variance])
    else:
        # Published Example 4.8 with equal initial weights. For each two-item
        # group the MINQUE normal has diagonal 5/8 and off-diagonal 1/8.
        y = [F('1.6'), F('.9'), F('-.9'), F('3.6')]
        mean = sum(y) / 4; residuals = [v - mean for v in y]
        rhs = [sum(v * v for v in residuals[:2]) / 2, sum(v * v for v in residuals[2:]) / 2]
        diag, off = F(5, 8), F(1, 8)
        candidates = [(diag * rhs[0] - off * rhs[1]) / (diag * diag - off * off),
                      (diag * rhs[1] - off * rhs[0]) / (diag * diag - off * off)]
        assert candidates == [F(-37, 25), F(42, 5)]
        assert r['outcome'] == 'nonpositive-component' and len(r['iterations']) == 1
        assert r['convergedVariances'] is None and r['finalFit'] is None
        equal(r['iterations'][0]['normal'], [[diag, off], [off, diag]])
        equal(r['iterations'][0]['rightHandSide'], rhs)
        equal(r['iterations'][0]['candidateVariances'], candidates)
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
