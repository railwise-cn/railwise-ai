"""Recorded replay cohort on a closed SQLite copy; never a production KPI.

Migration is additive: read only engineering_monitoring_replay_events, leave the
legacy five-check verification metrics untouched, and never fabricate starts for
older databases. Missing table is not-measurable; empty cohort has a null rate;
any malformed row, even outside the period, makes the whole result unavailable.
Only recorded passed terminals before end contribute to the start-cohort rate.
Not-evaluated, not-applicable and incomplete starts remain in its denominator.
"""
import argparse
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

TABLE = 'engineering_monitoring_replay_events'
STATUSES = ('passed', 'failed', 'not-evaluated', 'not-applicable', 'incomplete')
REASONS = {
    'matched': 'passed', 'no-monitoring-analysis': 'not-applicable',
    'unsupported-algorithm': 'not-evaluated', 'resource-limit': 'not-evaluated',
    'source-unavailable': 'not-evaluated', 'ambiguous-tie-order': 'not-evaluated',
    'prerequisite-failed': 'failed', 'input-invalid': 'failed',
    'result-mismatch': 'failed', 'source-mismatch': 'failed',
}
MAX_EVENTS = 1_000_000
MAX_JSON_BYTES = 65_536


class InvalidEvidence(ValueError):
    pass


def require(condition):
    if not condition:
        raise InvalidEvidence('invalid recorded replay evidence')


def instant(value):
    require(isinstance(value, str) and len(value) <= 40)
    require(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})', value))
    offset = re.search(r'([+-])(\d{2}):(\d{2})$', value)
    if offset:
        require(int(offset[2]) <= 23 and int(offset[3]) <= 59)
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def digest(value):
    require(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value))


def text(value, maximum=240):
    require(isinstance(value, str) and 0 < len(value.encode('utf-16-le')) // 2 <= maximum)
    value.encode('utf-8', errors='strict')


def fields(value, required, optional=()):
    require(isinstance(value, dict))
    require(set(required) <= value.keys() <= set(required) | set(optional))


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    require(isinstance(raw, str) and len(raw.encode('utf-8')) <= MAX_JSON_BYTES)
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False))


def js_json(value):
    # This schema contains strings, arrays, objects and only the integer schemaVersion.
    # Thus compact UTF-8 JSON matches JSON.stringify without float formatting ambiguity.
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def validate_result(result, event):
    fields(result, ('schemaVersion', 'attemptId', 'projectId', 'manifestId', 'checkedAt',
                    'status', 'reasonCode', 'comparisonVersion', 'execution', 'analyses'), ('detail',))
    require(type(result['schemaVersion']) is int and result['schemaVersion'] == 1)
    for key, event_key in [('attemptId', 'id'), ('projectId', 'projectId'), ('manifestId', 'manifestId')]:
        text(result[key])
        require(result[key] == event[event_key])
    instant(result['checkedAt'])
    require(result['comparisonVersion'] == 'monitoring-results-exact-1')
    require(isinstance(result['reasonCode'], str) and result['reasonCode'] in REASONS
            and REASONS[result['reasonCode']] == result['status'])
    if 'detail' in result:
        require(isinstance(result['detail'], str) and len(result['detail'].encode('utf-16-le')) // 2 <= 240)
    execution_keys = ('runtimeVersion', 'node', 'v8', 'icu', 'platform', 'arch', 'timezone', 'locale', 'timeBasis')
    fields(result['execution'], execution_keys)
    for key in execution_keys:
        text(result['execution'][key], 160)
    require(result['execution']['timeBasis'] == 'ISO-unzoned-UTC')
    analyses = result['analyses']
    require(isinstance(analyses, list) and len(analyses) <= 1)
    require(result['status'] != 'passed' or len(analyses) == 1)
    require(result['status'] != 'not-applicable' or not analyses)
    for item in analyses:
        fields(item, ('analysisId', 'datasetId', 'algorithmVersion', 'inputHash', 'storedResultsHash', 'status', 'reasonCode'),
               ('recomputedResultsHash', 'sourceFileHash', 'sourceContextHash'))
        for key in ('analysisId', 'datasetId', 'algorithmVersion'):
            text(item[key])
        for key in ('inputHash', 'storedResultsHash', 'recomputedResultsHash', 'sourceFileHash', 'sourceContextHash'):
            if key in item:
                digest(item[key])
        require(item['status'] == result['status'] and item['reasonCode'] == result['reasonCode'])
        require(item['status'] != 'not-applicable')
        if item['status'] == 'passed':
            require(all(key in item for key in ('recomputedResultsHash', 'sourceFileHash', 'sourceContextHash')))
            require(item['storedResultsHash'] == item['recomputedResultsHash'])
        if item['reasonCode'] == 'result-mismatch':
            require('recomputedResultsHash' in item and item['storedResultsHash'] != item['recomputedResultsHash'])


def aggregate(db, start, end):
    table = db.execute('SELECT type FROM sqlite_master WHERE name=?', (TABLE,)).fetchone()
    if table is None:
        return {'status': 'not-measurable', 'reason': 'replay-table-missing', 'denominator': None, 'counts': None, 'recordedPassRate': None}
    require(table[0] == 'table')
    columns = list(db.execute(f'PRAGMA table_info({TABLE})'))
    expected = [('sequence', 'INTEGER'), ('attempt_id', 'TEXT'), ('phase', 'TEXT'), ('project_id', 'TEXT'),
                ('manifest_id', 'TEXT'), ('occurred_at', 'TEXT'), ('record_hash', 'TEXT'), ('data_json', 'TEXT')]
    require([(row[1], row[2].upper()) for row in columns] == expected)
    require(columns[0][5] == 1 and all(row[3] == 1 for row in columns[1:]))
    require(db.execute(f'SELECT count(*) FROM {TABLE}').fetchone()[0] <= MAX_EVENTS)
    attempts = {}
    last_sequence = 0
    for row in db.execute(f'SELECT sequence,attempt_id,phase,project_id,manifest_id,occurred_at,record_hash,data_json FROM {TABLE} ORDER BY sequence'):
        sequence, attempt_id, phase, project_id, manifest_id, occurred_at, record_hash, raw = row
        require(type(sequence) is int and sequence > last_sequence)
        last_sequence = sequence
        for value in (attempt_id, project_id, manifest_id):
            text(value)
        require(phase in ('started', 'finished'))
        digest(record_hash)
        event = strict_json(raw)
        require(sha(raw) == record_hash)
        base = ('schemaVersion', 'id', 'projectId', 'manifestId', 'startedAt', 'phase')
        fields(event, base if phase == 'started' else (*base, 'previousHash', 'resultHash', 'result'))
        require(type(event['schemaVersion']) is int and event['schemaVersion'] == 1)
        require((event['id'], event['projectId'], event['manifestId'], event['phase']) == (attempt_id, project_id, manifest_id, phase))
        began = instant(event['startedAt'])
        occurred = instant(occurred_at)
        if phase == 'started':
            require(attempt_id not in attempts and occurred_at == event['startedAt'])
            attempts[attempt_id] = {'event': event, 'hash': record_hash, 'start': began, 'finish': None}
        else:
            require(attempt_id in attempts)
            attempt = attempts[attempt_id]
            require(attempt['finish'] is None)
            require(all(event[key] == attempt['event'][key] for key in base if key != 'phase'))
            require(event['previousHash'] == attempt['hash'])
            digest(event['resultHash'])
            validate_result(event['result'], event)
            require(sha(js_json(event['result'])) == event['resultHash'])
            require(occurred_at == event['result']['checkedAt'] and occurred >= began)
            attempt['finish'] = (occurred, event['result']['status'])
    counts = dict.fromkeys(STATUSES, 0)
    for attempt in attempts.values():
        if start <= attempt['start'] < end:
            finish = attempt['finish']
            counts[finish[1] if finish and finish[0] < end else 'incomplete'] += 1
    denominator = sum(counts.values())
    return {'status': 'measured' if denominator else 'no-samples', 'denominator': denominator, 'counts': counts,
            'recordedPassRate': counts['passed'] / denominator if denominator else None}


def measure(database, start, end):
    """Read one closed database copy; return unavailable without partial counts on corruption."""
    begin, finish = instant(start), instant(end)
    require(begin < finish)
    report = {
        'schemaVersion': 1, 'cohort': 'recorded-replay',
        'period': {'start': begin.isoformat().replace('+00:00', 'Z'), 'end': finish.isoformat().replace('+00:00', 'Z')},
        'basis': 'started-in-period; terminal-before-end; all-recorded-rows-validated',
        'productionKpi': False,
        'limitations': ['Recorded calls only; missing starts are outside the denominator.',
                        'Historical receipts only; no current source, output, numerical replay or identity approval verification.'],
    }
    try:
        path = Path(database).resolve(strict=True)
        require(path.is_file() and not any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')))
        with path.open('rb') as source:
            before = hashlib.file_digest(source, 'sha256').hexdigest()
        db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
        try:
            db.execute('PRAGMA query_only=ON')
            db.execute('BEGIN')
            require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)])
            metric = aggregate(db, begin, finish)
            db.rollback()
        finally:
            db.close()
        with path.open('rb') as source:
            after = hashlib.file_digest(source, 'sha256').hexdigest()
        require(before == after and not any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')))
        report.update(metric)
        report['sourceSha256'] = before
    except (InvalidEvidence, ValueError, TypeError, KeyError, OSError, sqlite3.Error, UnicodeError, RecursionError, OverflowError):
        report.update(status='unavailable', reason='invalid-or-unstable-snapshot', denominator=None, counts=None, recordedPassRate=None)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-copy', required=True, help='Closed application SQLite copy; never the live database')
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    args = parser.parse_args()
    try:
        result = measure(args.database_copy, args.start, args.end)
    except (InvalidEvidence, ValueError):
        parser.error('start and end must be explicit timezone ISO instants with start < end')
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 1 if result['status'] == 'unavailable' else 0


if __name__ == '__main__':
    raise SystemExit(main())
