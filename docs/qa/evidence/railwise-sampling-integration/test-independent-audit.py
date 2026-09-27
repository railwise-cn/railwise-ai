#!/usr/bin/env python3
"""Mutate temporary backup copies only; supplied fixture databases stay read-only.

Requires a settled real-service synthetic fixture with one population and
process/final-field runs. Does not import or execute product code.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile

spec = importlib.util.spec_from_file_location('sampling_audit', Path(__file__).with_name('railwise-sampling-independent-audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

def rehash_sample(db, _root):
    row = dict(db.execute("SELECT * FROM sampling_runs WHERE stage='final-field'").fetchone())
    value = json.loads(row['data_json'])
    value['plan']['batches'][0]['selectedUnitProductIds'][0] = 'not-a-member'
    row['data_json'] = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    row['record_hash'] = audit.digest({key:item for key,item in row.items() if key != 'record_hash'})
    db.execute('UPDATE sampling_runs SET data_json=?,record_hash=? WHERE id=?', (row['data_json'],row['record_hash'],row['id']))

def blob_rehash(db, _root):
    row = dict(db.execute('SELECT * FROM sampling_populations').fetchone())
    row['definition_bytes'] = b'changed declaration'
    unsigned = {key:value for key,value in row.items() if key not in ['record_hash','definition_bytes']}
    unsigned['definition_bytes_sha256'] = audit.sha(row['definition_bytes'])
    db.execute('UPDATE sampling_populations SET definition_bytes=?,record_hash=?', (row['definition_bytes'],audit.digest(unsigned)))

def project_changed(_db, root):
    with sqlite3.connect(root/'engineering.sqlite3') as db:
        row = db.execute('SELECT id,data_json FROM engineering_projects').fetchone()
        value = json.loads(row[1]); value['revision'] += 1
        db.execute('UPDATE engineering_projects SET revision=?,data_json=? WHERE id=?',
            (value['revision'],json.dumps(value,ensure_ascii=False,separators=(',',':')),row[0]))

def duplicate_stage(db, _root):
    row = dict(db.execute("SELECT * FROM sampling_runs WHERE stage='final-field'").fetchone())
    value = json.loads(row['data_json']); value['id'] = 'forged-duplicate-id'
    value['runHash'] = audit.digest({key:item for key,item in value.items() if key not in ['plan','runHash']})
    row['id'] = value['id']; row['idempotency_key'] = 'duplicate-stage-key'
    row['request_hash'] = audit.digest(dict(populationId=value['populationId'],idempotencyKey=row['idempotency_key'],stage=value['stage'],inspectionMode=value['inspectionMode']))
    row['data_json'] = json.dumps(value,ensure_ascii=False,separators=(',',':'))
    row['record_hash'] = audit.digest({key:item for key,item in row.items() if key != 'record_hash'})
    db.executescript('CREATE TABLE replacement AS SELECT * FROM sampling_runs; DROP TABLE sampling_runs; ALTER TABLE replacement RENAME TO sampling_runs;')
    db.execute('INSERT INTO sampling_runs('+','.join(row)+') VALUES('+','.join('?' for _ in row)+')',list(row.values()))

CASES = [
    ('SQL stage identity tamper', lambda db,_root: db.execute("UPDATE sampling_runs SET stage='acceptance' WHERE stage='final-field'"), 'run-sql-row-hash'),
    ('sample forged with repaired outer row hash', rehash_sample, 'independent-plan-hmac-table-replay'),
    ('actual definition bytes changed with repaired row hash', blob_rehash, 'definition-actual-byte-binding'),
    ('current project revision changed', project_changed, 'stale-project-binding'),
    ('all run records removed', lambda db,_root: db.execute('DELETE FROM sampling_runs'), 'not-evaluated'),
    ('valid-looking duplicate same-stage draw with repaired hashes', duplicate_stage, 'same-stage-redraw')
]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--output',type=Path)
    args = parser.parse_args()
    results = []
    for name, mutate, expected in CASES:
        with tempfile.TemporaryDirectory(prefix='sampling-audit-negative-') as temp:
            root = Path(temp)
            for name_db in ['engineering.sqlite3','survey-sampling.sqlite3']:
                source = sqlite3.connect((args.root/name_db).resolve(strict=True).as_uri()+'?mode=ro',uri=True)
                source.execute('PRAGMA query_only=ON')
                destination = sqlite3.connect(root/name_db)
                try: source.backup(destination)
                finally: source.close(); destination.close()
            db = sqlite3.connect(root/'survey-sampling.sqlite3'); db.row_factory = sqlite3.Row
            try:
                db.executescript('DROP TRIGGER sampling_runs_no_update; DROP TRIGGER sampling_populations_no_update; DROP TRIGGER sampling_runs_no_delete;')
                mutate(db, root); db.commit()
            finally: db.close()
            try: actual = audit.audit(root)['status']
            except audit.AuditFailure as error: actual = str(error)
            if actual != expected: raise AssertionError((name,actual,expected))
            results.append({'case':name,'result':'passed','expectedAuditResult':expected})
    output = json.dumps(results,ensure_ascii=False,indent=2)+'\n'
    if args.output: args.output.write_text(output,encoding='utf-8')
    print(output,end='')

if __name__ == '__main__': main()
