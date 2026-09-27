#!/usr/bin/env python3
"""Read-only SQLite verification for four synthetic scoring acceptance inputs.

Usage: python3 inspect-packaged-records.py DB --project PROJECT_ID
Uses only Python stdlib and Fraction; never imports the production scorer.
This is stored-record verification, not proof that an installed GUI was exercised.
"""
import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

CASES = ('full', 'child-veto', 'pending', 'multiple-sixty')
STANDARD_HASH = '96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487'
TREE = (
    ('data-quality', Fraction(1, 2), (('mathematical-accuracy', Fraction(3, 10)), ('observation-quality', Fraction(2, 5)), ('calculation-quality', Fraction(3, 10)))),
    ('point-quality', Fraction(3, 10), (('selection-quality', Fraction(1, 2)), ('marking-quality', Fraction(1, 2)))),
    ('material-quality', Fraction(1, 5), (('presentation-quality', Fraction(3, 10)), ('completeness', Fraction(7, 10)))),
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def forbidden_constant(value):
    raise ValueError('Non-finite JSON constant: ' + value)


def load_json(value):
    return json.loads(value, object_pairs_hook=strict_pairs, parse_constant=forbidden_constant)


def json_text(value, sort=False):
    # These contracts use ASCII field names and integer JSON numbers only.
    # Precisions and fractions remain strings, so Python/JS float formatting is absent.
    return json.dumps(value, ensure_ascii=False, sort_keys=sort, separators=(',', ':'), allow_nan=False)


def digest(value):
    return sha(json_text(value, sort=True))


def fraction(value):
    require(isinstance(value, dict) and set(value) == {'numerator', 'denominator'}, 'Missing exact fraction')
    n, d = int(value['numerator']), int(value['denominator'])
    require(d > 0, 'Nonpositive fraction denominator')
    result = Fraction(n, d)
    require(str(result.numerator) == value['numerator'] and str(result.denominator) == value['denominator'], 'Noncanonical exact fraction')
    return result


def accuracy(model):
    require(model['aCount'] == 0, 'Fixture must explicitly have A=0')
    scores = []
    for item in model['items']:
        m, m0 = Fraction(item['m']), Fraction(item['m0'])
        require(0 <= m <= m0 and m0 > 0, 'Precision outside reviewed formula domain')
        scores.append(Fraction(100) if m <= Fraction(3, 10) * m0 else 60 + Fraction(400, 7) * (m0 - m) / m0)
    if len(scores) > 1 and min(scores) == 60:
        return None, scores
    require(model['aggregation']['kind'] == 'arithmetic', 'Fixture oracle expects arithmetic precision aggregation')
    return sum(scores) / len(scores), scores


def independent_expected(name, model):
    if name == 'multiple-sixty':
        total, items = accuracy(model['model'])
        require(total is None and items == [60, 100], 'Expected precision pair 60 and 100')
        return {'state': 'unavailable', 'reason': 'multiple_accuracy_equality_60', 'score': None, 'scope': 'declared-component-only', 'leaves': {}, 'elements': {}, 'precision': items}
    leaves, pending = {}, []
    for leaf in model['leaves']:
        key = leaf['subelementId']
        if leaf['state'] == 'pending':
            pending.append(key)
            continue
        require(leaf['state'] == 'checked', 'Four fixtures do not use scope exclusions')
        record = leaf['record']
        if record['kind'] == 'accuracy':
            value, _ = accuracy(record['model'])
            require(value is not None, 'Unit fixture accuracy must resolve')
        else:
            defect = record['defects']
            require(defect['a'] == 0 and Fraction(defect['t']) == 1, 'Four fixtures require A=0 and t=1')
            value = Fraction(100 - 12 * defect['b'] - 4 * defect['c'] - defect['d'])
        leaves[key] = value
    elements = {parent: sum(leaves[child] * weight for child, weight in children)
                for parent, _weight, children in TREE if all(child in leaves for child, _ in children)}
    if name == 'child-veto':
        require(leaves['observation-quality'] == 52, 'Independent defect score must be52')
        return {'state': 'nonconforming', 'reason': 'child_below_60_or_a_veto', 'score': None, 'scope': 'complete-declared-product-profile', 'leaves': leaves, 'elements': elements}
    if name == 'pending':
        require(pending == ['completeness'], 'Expected completeness pending')
        return {'state': 'unavailable', 'reason': 'pending_subelement', 'score': None, 'scope': 'unresolved-declared-product-profile', 'leaves': leaves, 'elements': elements}
    require(not pending and min(leaves.values()) >= 60, 'Full scope must contain all qualified leaves')
    score = sum(elements[parent] * weight for parent, weight, _children in TREE)
    require(score == Fraction(9141, 100), 'Independent full score differs from9141/100')
    return {'state': 'calculated', 'reason': 'calculated', 'score': score, 'scope': 'complete-declared-product-profile', 'leaves': leaves, 'elements': elements}


def verify_row(row, name, original, fixture, project):
    record = load_json(row['data_json'])
    request_bytes, declaration_bytes = row['request_bytes'], row['declaration_bytes']
    require(isinstance(request_bytes, bytes) and isinstance(declaration_bytes, bytes), 'Expected SQLite raw BLOBs')
    require(declaration_bytes == original, 'Declaration BLOB differs from the exact acceptance input bytes')
    request_text = request_bytes.decode('utf-8', errors='strict')
    declaration_text = declaration_bytes.decode('utf-8', errors='strict')
    require(request_text.encode('utf-8') == request_bytes and declaration_text.encode('utf-8') == declaration_bytes, 'UTF-8 roundtrip failed')
    require(record['requestJson'] == request_text and record['declarationJson'] == declaration_text, 'Stored text does not equal raw BLOB bytes')
    request = load_json(request_text)
    require(load_json(declaration_text) == fixture == record['declaration'] == record['result']['request'], 'Original/normalized/kernel declaration mismatch')
    require(set(request) == {'kind', 'acknowledged', 'expectedProjectRevision', 'idempotencyKey', 'declarationJson', 'modelBasisStatement'}, 'Unexpected request fields')
    for left, right in (('kind', 'kind'), ('acknowledged', 'acknowledged'), ('expectedProjectRevision', 'projectRevision'), ('idempotencyKey', 'idempotencyKey'), ('declarationJson', 'declarationJson'), ('modelBasisStatement', 'modelBasisStatement')):
        require(request[left] == record[right], 'Request metadata mismatch: ' + left)
    require(request['acknowledged'] is True and record['kind'] == fixture['operation'], 'Missing explicit declaration acknowledgement or stage mismatch')
    for left, right in (('id', 'id'), ('project_id', 'projectId'), ('kind', 'kind'), ('project_revision', 'projectRevision'), ('project_binding_hash', 'projectBindingHash'), ('idempotency_key', 'idempotencyKey'), ('request_hash', 'requestSha256'), ('record_hash', 'recordHash'), ('created_at', 'createdAt')):
        require(row[left] == record[right], 'SQLite/record metadata mismatch: ' + left)
    require(record['projectId'] == project and record['projectSnapshot']['id'] == project and record['projectSnapshot']['revision'] == record['projectRevision'], 'Project snapshot binding mismatch')
    require(record['schemaVersion'] == 1 and record['algorithmVersion'] == 'gbt24356-declared-exact-quality-scoring-1', 'Unsupported scoring version')
    require(record['modelNormalization'] == 'schema-normalized', 'Unsupported normalization')
    require(sha(request_bytes) == record['requestSha256'] and len(request_bytes) == record['requestSizeBytes'], 'Request hash/length mismatch')
    require(sha(declaration_bytes) == record['declarationSha256'] and len(declaration_bytes) == record['declarationSizeBytes'], 'Declaration hash/length mismatch')
    basis = record['modelBasisStatement'].encode('utf-8')
    require(sha(basis) == record['modelBasisSha256'] and len(basis) == record['modelBasisSizeBytes'], 'Basis hash/length mismatch')
    for source, target in (('projectSnapshot', 'projectBindingHash'), ('declaration', 'modelHash'), ('result', 'resultHash'), ('replayEnvironment', 'replayEnvironmentHash')):
        require(digest(record[source]) == record[target], 'Canonical object hash mismatch: ' + source)
    require(digest({key: value for key, value in record.items() if key != 'recordHash'}) == record['recordHash'], 'Record hash mismatch')
    metadata = {key: value for key, value in row.items() if key not in ('request_bytes', 'declaration_bytes', 'storage_hash')}
    require(digest({**metadata, 'request_bytes_sha256': sha(request_bytes), 'declaration_bytes_sha256': sha(declaration_bytes)}) == row['storage_hash'], 'SQLite storage hash mismatch')
    result = record['result']
    require(result['algorithmVersion'] == record['algorithmVersion'] and result['schemaVersion'] == 1, 'Kernel version binding mismatch')
    require(sha(json_text(result['request'])) == result['requestSha256'], 'Kernel normalized JSON request hash mismatch')
    require(result['source']['sha256'] == STANDARD_HASH == fixture['sourceDigest'], 'Reviewed standard source mismatch')
    require(fixture['profileWeightTable'] == 43 and fixture['profileClassificationTable'] == 44 and fixture['productProfileId'] == 'planar-control-point', 'Acceptance fixtures must use declared planar-control tables43/44')
    for object_ in (record, result):
        require(object_['status'] == 'declared-inspection-trial-only' and object_['formalResultsModified'] is False and object_['engineeringDecision'] == 'not-evaluated', 'Trial/engineering boundary mismatch')
        for key in ('evidenceAuthenticity', 'classificationAuthenticity', 'priorQualificationAuthenticity'):
            require(object_[key] == 'not-verified', 'Unverified trust boundary changed: ' + key)
    require(record['declarationTrust'] == 'caller-declared-not-authenticated' and record['checkpointTrust'] == 'local-records-only', 'Local declaration/checkpoint trust mismatch')
    require(result['standardConformity'] == 'not-authenticated' and result['humanSignatureVerification'] == 'not-evaluated' and result['observationAction'] == 'none', 'Conformity/signature/action boundary mismatch')
    expected = independent_expected(name, fixture)
    value = result['result']
    require(value['state'] == expected['state'] == record['outcome'] and value['reason'] == expected['reason'], 'Scoring outcome/reason mismatch')
    require(result['scopeAssessment'] == expected['scope'] == record['scopeAssessment'], 'Declared scope mismatch')
    if expected['score'] is None:
        require(value['score'] is None and value['grade'] is None and value['qualified'] is not True, 'Unresolved/failed result must not expose an accepted score/grade')
        require(value['rawScore'] is None, 'A partial arithmetic total must not be exposed as the failed unit score')
        require(value['qualified'] is (False if expected['state'] == 'nonconforming' else None), 'Failure/unavailable qualification state mismatch')
    else:
        require(fraction(value['score']) == expected['score'] and value['grade'] == 'excellent' and value['qualified'] is True, 'Full declared exact score/grade mismatch')
    trace = {item['nodeId']: item for item in result['trace']}
    require(len(trace) == len(result['trace']), 'Duplicate trace identity')
    for parent, parent_weight, children in TREE if name != 'multiple-sixty' else ():
        require(fraction(trace[parent]['originalWeight']) == parent_weight == fraction(trace[parent]['effectiveWeight']), 'Parent exact weight mismatch')
        for child, child_weight in children:
            require(fraction(trace[child]['originalWeight']) == child_weight == fraction(trace[child]['effectiveWeight']), 'Child exact weight mismatch')
            if child not in expected['leaves']:
                require(trace[child]['result']['state'] == 'unavailable' and trace[child]['result']['score'] is None, 'Pending leaf became scored')
                continue
            predicted = expected['leaves'][child]
            leaf_value = trace[child]['result']
            require(fraction(leaf_value['score'] if predicted >= 60 else leaf_value['rawScore']) == predicted, 'Independent leaf-score mismatch: ' + child)
            if predicted < 60:
                require(leaf_value['state'] == 'nonconforming' and leaf_value['score'] is None, 'Below60 leaf veto missing')
        if parent in expected['elements'] and all(expected['leaves'].get(child, 0) >= 60 for child, _weight in children):
            require(fraction(trace[parent]['result']['score']) == expected['elements'][parent], 'Independent element-score mismatch')
        else:
            require(trace[parent]['result']['score'] is None and trace[parent]['result']['grade'] is None, 'Incomplete or vetoed parent exposes an accepted score/grade')
    if name == 'pending':
        require(result['pendingSubelementIds'] == ['completeness'] and result['excludedSubelementIds'] == [], 'Pending evidence was treated as scope exclusion')
    if name == 'multiple-sixty':
        require([fraction(trace[f'accuracy/{index}']['result']['score']) for index in range(2)] == [60, 100], 'Precision trace differs from60/100')
    return {'case': name, 'recordId': record['id'], 'projectId': project, 'projectRevision': record['projectRevision'], 'requestSha256': record['requestSha256'], 'declarationSha256': record['declarationSha256'], 'recordHash': record['recordHash'], 'outcome': value['state'], 'scope': result['scopeAssessment'], 'exactScore': value['score'], 'originalBytesVerified': True, 'sqlBindingsVerified': True, 'independentFractionChecksPassed': True}


def inspect(database, project, inputs):
    fixtures = {name: (inputs / f'quality-{name}.json').read_bytes() for name in CASES}
    parsed = {name: load_json(raw.decode('utf-8')) for name, raw in fixtures.items()}
    uri = database.resolve().as_uri() + '?mode=ro'
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    results, skipped = [], 0
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        require(connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'SQLite quick_check failed')
        require(connection.execute('SELECT count(*) FROM quality_scoring_records WHERE project_id=?', (project,)).fetchone()[0] <= 128, 'Project record count exceeds inspector budget')
        rows = connection.execute('''SELECT id,project_id,kind,project_revision,project_binding_hash,idempotency_key,request_hash,record_hash,created_at,storage_hash,
          CASE WHEN length(CAST(data_json AS BLOB))<=4194304 THEN data_json END AS data_json,
          CASE WHEN length(request_bytes)<=524288 THEN request_bytes END AS request_bytes,
          CASE WHEN length(declaration_bytes)<=262144 THEN declaration_bytes END AS declaration_bytes,
          length(CAST(data_json AS BLOB)) AS inspected_data_bytes,
          length(request_bytes) AS inspected_request_bytes, length(declaration_bytes) AS inspected_declaration_bytes
          FROM quality_scoring_records WHERE project_id=? ORDER BY created_at,id''', (project,))
        for sqlite_row in rows:
            row = dict(sqlite_row)
            for key, limit in (('inspected_data_bytes', 4 * 1024 * 1024), ('inspected_request_bytes', 512 * 1024), ('inspected_declaration_bytes', 256 * 1024)):
                require(isinstance(row[key], int) and row[key] <= limit, 'Stored record exceeds inspection budget')
                del row[key]
            record = load_json(row['data_json'])
            name = next((key for key, model in parsed.items() if record.get('declaration') == model), None)
            if name is None:
                skipped += 1
                continue
            results.append(verify_row(row, name, fixtures[name], parsed[name], project))
        missing = set(CASES) - {record['case'] for record in results}
        require(not missing, 'Missing matching acceptance declarations: ' + ','.join(sorted(missing)))
    finally:
        connection.close()
    return {'schemaVersion': 1, 'verification': 'stdlib-sqlite-and-Fraction-independent-record-check', 'guiExecutionVerified': False, 'professionalApproval': False, 'currentProjectRevisionValidated': False, 'storedProjectSnapshotBindingVerified': True, 'database': str(database.resolve()), 'projectId': project, 'recordsChecked': len(results), 'unmatchedProjectRecordsNotEvaluated': skipped, 'allFourCasesPresent': True, 'results': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('--project', required=True)
    parser.add_argument('--inputs', type=Path, default=Path(__file__).resolve().parent / 'inputs')
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.database, args.project, args.inputs), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, KeyError, TypeError, OSError, sqlite3.Error, ZeroDivisionError) as error:
        print(json.dumps({'verified': False, 'guiExecutionVerified': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
