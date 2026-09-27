#!/usr/bin/env python3
"""Read-only acceptance oracle for the three statistical/Huber inputs beside this script.

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
    if name.startswith('huber-'):
        assert r['outcome'] == 'stationary'
        assert r['formalWeightsModified'] is False and r['parameterCovariance'] is None
        assert r['uniqueMinimizerCertified'] is False
        state = r['states'][-1]
        x = r['acceptedParameters'][0]
        assert abs(x - (1/3 if name == 'huber-unique' else 4)) < 1e-9
        expected_objective = F(28, 3) if name == 'huber-unique' else F(18)
        equal(state['objective'], expected_objective)
        y = [row['value'] for row in original['observations']]
        residuals = [v-x for v in y]
        equal(state['residuals'], residuals)
        score = sum(max(-1, min(1, v)) for v in residuals) / 2
        assert abs(score) <= 1e-10
        for i,v in enumerate(residuals):
            expected_multiplier = 1 if abs(v)<=1 else 1/abs(v)
            equal(state['robustMultipliers'][i],expected_multiplier)
            equal(state['derivedIrlsWeights'][i],expected_multiplier)
        if name == 'huber-flat':
            assert r['uniquenessAssessment'] == 'not-established' and len(r['states']) == 1
        else:
            assert r['uniquenessAssessment'] == 'strict-inlier-full-rank-sufficient-condition'
    else:
        from statistics import NormalDist
        assert r['outcome'] == 'evaluated' and r['denominator'] == 4
        alpha = original['alpha']/4
        equal(r['memberAlpha'],alpha)
        assert [x['memberId'] for x in original['statistics']] == ['c-chi','b-t','a-normal']
        assert [x['memberId'] for x in r['request']['statistics']] == ['a-normal','b-t','c-chi']
        expected_p = [math.erfc(3/math.sqrt(2)), 2*math.atan(1/3)/math.pi, math.exp(-2)]
        expected_critical = [NormalDist().inv_cdf(1-alpha/2),1/math.tan(math.pi*alpha/2),-2*math.log(alpha)]
        for item,p,critical in zip(r['results'][:3],expected_p,expected_critical):
            assert item['status'] == 'calculated'
            equal(item['pValue'],p);equal(item['adjustedPValue'],min(1,4*p));equal(item['criticalMagnitude'],critical)
            assert item['comparison'] == ('p-below-adjusted-alpha' if p<alpha else 'p-above-adjusted-alpha')
            assert item['numericalResolutionInterval'][0] < critical < item['numericalResolutionInterval'][1]
        assert r['results'][3] == {'memberId':'d-missing','status':'unavailable','reason':'not-supplied'}
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
