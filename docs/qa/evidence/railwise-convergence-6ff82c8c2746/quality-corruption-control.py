#!/usr/bin/env python3
"""Local synthetic acceptance fixture only. No mutation without inject/restore."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

ROOT = Path('/private/tmp/railwise-survey-6ff82c8')
EVIDENCE = ROOT / 'evidence'
DATABASE = ROOT / 'home/.workwise/runtime/engineering/survey-quality-scoring.sqlite3'
PROJECT = 'project_9d966747-63bc-4658-9ba6-a8635423a7e0'
RECORD = 'quality_scoring_5cfda612-87bd-4af1-bb3d-85134623733f'
TRIGGER = 'quality_scoring_records_no_update'
BACKUP = EVIDENCE / 'quality-corruption-original-declaration.bin'
MANIFEST = EVIDENCE / 'quality-corruption-backup.json'
TABLE = 'quality_scoring_records'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(row):
    return {key: {'blobBase64': base64.b64encode(value).decode('ascii')}
            if isinstance(value, bytes) else value for key, value in dict(row).items()}


def state(db):
    rows = db.execute('SELECT * FROM quality_scoring_records ORDER BY id').fetchall()
    return {row['id']: encoded(row) for row in rows}


def triggers(db):
    return [dict(row) for row in db.execute(
        "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name", (TABLE,))]


def target(db):
    row = db.execute('SELECT * FROM quality_scoring_records WHERE project_id=? AND id=?', (PROJECT, RECORD)).fetchone()
    require(row is not None, 'Exact synthetic project/record not found')
    record = json.loads(row['data_json'])
    require(record['projectId'] == PROJECT and record['id'] == RECORD and row['kind'] == 'unit', 'Target binding changed')
    require(record['result']['result']['score'] == {'numerator': '9141', 'denominator': '100'}, 'Not the reviewed full-score fixture')
    require(record['formalResultsModified'] is False and record['declarationTrust'] == 'caller-declared-not-authenticated', 'Synthetic trial boundaries changed')
    return row


def connect(readonly):
    require(DATABASE.resolve() == DATABASE and DATABASE.is_file(), 'Fixed candidate database path changed')
    db = sqlite3.connect(DATABASE.as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, isolation_level=None, timeout=5)
    db.row_factory = sqlite3.Row
    if readonly:
        db.execute('PRAGMA query_only=ON')
    return db


def prepare():
    require(not BACKUP.exists() and not MANIFEST.exists(), 'Refusing to overwrite original backup')
    db = connect(True)
    try:
        db.execute('BEGIN')
        row = target(db)
        original = row['declaration_bytes']
        require(isinstance(original, bytes), 'Original declaration is not a BLOB')
        record = json.loads(row['data_json'])
        require(original.decode('utf-8') == record['declarationJson'], 'Original declaration is already inconsistent')
        require(sha(original) == record['declarationSha256'], 'Original declaration hash failed')
        trigger_list = triggers(db)
        update = next((t for t in trigger_list if t['name'] == TRIGGER), None)
        require(update is not None and 'BEFORE UPDATE' in update['sql'] and 'append-only' in update['sql'], 'Expected update guard absent')
        manifest = {'database': str(DATABASE), 'projectId': PROJECT, 'recordId': RECORD,
                    'originalBytes': len(original), 'originalSha256': sha(original),
                    'injectedBytes': len(original) + 1, 'injectedSha256': sha(original + b' '),
                    'originalRow': encoded(row), 'originalTriggers': trigger_list,
                    'mutation': 'Append exactly one ASCII space (0x20) to declaration_bytes only; keep all stored hashes unchanged',
                    'status': 'prepared-not-injected', 'databaseAccessDuringPreparation': 'mode=ro/query_only',
                    'commands': {action: [sys.executable, str(Path(__file__).resolve()), action] for action in ('inject', 'restore')}}
        with BACKUP.open('xb') as out:
            out.write(original)
        with MANIFEST.open('x') as out:
            out.write(json.dumps(manifest, indent=2) + '\n')
        return {key: manifest[key] for key in ('status', 'projectId', 'recordId', 'originalBytes', 'originalSha256', 'injectedSha256')}
    finally:
        db.close()


def mutate(action):
    manifest = json.loads(MANIFEST.read_text())
    original = BACKUP.read_bytes()
    require(manifest['database'] == str(DATABASE) and manifest['projectId'] == PROJECT and manifest['recordId'] == RECORD, 'Backup target mismatch')
    require(sha(original) == manifest['originalSha256'] and len(original) == manifest['originalBytes'], 'Original backup damaged')
    damaged = original + b' '
    require(sha(damaged) == manifest['injectedSha256'], 'Expected mutation hash mismatch')
    expected, replacement = (original, damaged) if action == 'inject' else (damaged, original)
    before_row = dict(manifest['originalRow'])
    before_row['declaration_bytes'] = {'blobBase64': base64.b64encode(expected).decode('ascii')}
    after_row = dict(manifest['originalRow'])
    after_row['declaration_bytes'] = {'blobBase64': base64.b64encode(replacement).decode('ascii')}
    db = connect(False)
    try:
        db.execute('BEGIN IMMEDIATE')
        require(encoded(target(db)) == before_row, 'Target changed outside the expected single-byte state; refusing mutation')
        require(triggers(db) == manifest['originalTriggers'], 'Append-only guards changed; refusing mutation')
        before = state(db)
        # Demonstrate the live guard blocks direct UPDATE before temporarily removing it.
        db.execute('SAVEPOINT guard_probe')
        blocked = False
        try:
            db.execute('UPDATE quality_scoring_records SET declaration_bytes=? WHERE project_id=? AND id=?', (replacement, PROJECT, RECORD))
        except sqlite3.IntegrityError as error:
            require('append-only' in str(error), 'Unexpected direct UPDATE failure')
            blocked = True
        finally:
            db.execute('ROLLBACK TO guard_probe')
            db.execute('RELEASE guard_probe')
        require(blocked, 'Append-only trigger failed to block direct UPDATE')
        original_trigger = next(t['sql'] for t in manifest['originalTriggers'] if t['name'] == TRIGGER)
        db.execute('DROP TRIGGER quality_scoring_records_no_update')
        changed = db.execute('UPDATE quality_scoring_records SET declaration_bytes=? WHERE project_id=? AND id=?', (replacement, PROJECT, RECORD))
        require(changed.rowcount == 1, 'Unexpected mutation row count')
        db.execute(original_trigger)
        require(triggers(db) == manifest['originalTriggers'], 'Trigger recreation differed from original SQL')
        require(encoded(target(db)) == after_row, 'Mutation altered more than the designated declaration bytes')
        expected_rows = dict(before)
        expected_rows[RECORD] = after_row
        require(state(db) == expected_rows, 'Another record changed inside mutation transaction')
        db.execute('COMMIT')
        return {'status': 'injected' if action == 'inject' else 'restored', 'projectId': PROJECT, 'recordId': RECORD,
                'directUpdateBlocked': True, 'singleImmediateTransaction': True, 'originalTriggerSqlRestored': True,
                'allOtherRowsAndFieldsUnchanged': True, 'beforeBytes': len(expected), 'afterBytes': len(replacement),
                'beforeSha256': sha(expected), 'afterSha256': sha(replacement)}
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'inject', 'restore'])
    action = parser.parse_args().action
    result = prepare() if action == 'prepare' else mutate(action)
    print(json.dumps({'command': [sys.executable, str(Path(__file__).resolve()), action], 'result': result}, indent=2))


if __name__ == '__main__':
    main()
