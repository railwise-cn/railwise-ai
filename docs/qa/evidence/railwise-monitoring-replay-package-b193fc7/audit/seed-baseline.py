#!/usr/bin/env python3
"""One authorized closed synthetic historical snapshot, before new package GUI."""
import json
import os
from pathlib import Path
import sqlite3
from datetime import datetime, timezone
import audit

root, base = audit.ROOT, audit.BASE
output = base / 'historical-before-gui'
assert not output.exists()
seed_path = root / 'evidence/synthetic-historical-monitoring-seed.json'
seed_raw = seed_path.read_bytes()
seed = json.loads(seed_raw)
assert seed['fixtureOnly'] and not seed['realUserData'] and seed['oldOriginalSourceTableAbsent']
original = root / audit.DB_RELATIVE
files = [Path(str(original) + suffix) for suffix in ('', '-wal', '-shm', '-journal') if Path(str(original) + suffix).exists()]
audit.closed(root, files)
output.mkdir(mode=0o700)
copied = output / 'private-copied-originals'; copied.mkdir(mode=0o700)
tracked = {seed_path: audit.sha(seed_raw)}
for file in files:
    raw = file.read_bytes(); tracked[file] = audit.sha(raw)
    with (copied / file.name).open('xb') as handle:
        os.chmod(handle.name, 0o600); handle.write(raw)
audit.closed(root, files)
copy = sqlite3.connect((copied / original.name).as_uri() + '?mode=rw', uri=True)
copy.execute('PRAGMA query_only=ON')
assert copy.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
snapshot = output / 'private-engineering.sqlite3'
with snapshot.open('xb'):
    snapshot.chmod(0o600)
backup = sqlite3.connect(snapshot); copy.backup(backup); backup.close(); copy.close()
db = sqlite3.connect(snapshot.as_uri() + '?mode=ro&immutable=1', uri=True); db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
try:
    assert [row[0] for row in db.execute('SELECT id FROM engineering_projects')] == [seed['projectId']]
    for table in ('engineering_monitoring_sources', 'engineering_monitoring_replay_events'):
        assert db.execute('SELECT count(*) FROM sqlite_master WHERE name=?', (table,)).fetchone()[0] == 0
    def one(table, identity):
        row = db.execute('SELECT * FROM ' + table + ' WHERE id=?', (identity,)).fetchone()
        assert row
        value = json.loads(row['data_json'])
        assert value['id'] == identity
        return value, dict(row)
    project, project_sql = one('engineering_projects', seed['projectId'])
    manifest, manifest_sql = one('engineering_manifests', seed['manifestId'])
    dataset, dataset_sql = one('engineering_datasets', seed['datasetId'])
    analysis, analysis_sql = one('engineering_analyses', seed['analysisId'])
    run, run_sql = one('engineering_runs', manifest['runId'])
    chart, chart_sql = one('engineering_charts', manifest['charts'][0]['id'])
    assert analysis['inputHash'] == seed['inputHash'] and dataset['sourceFileHash'] == seed['sourceFileHash']
    business = {table: audit.legacy.typed_hash(row) for table, row in [('engineering_projects', project_sql), ('engineering_manifests', manifest_sql), ('engineering_datasets', dataset_sql), ('engineering_analyses', analysis_sql), ('engineering_runs', run_sql), ('engineering_charts', chart_sql)]}
    workspace = Path(project['workspace']).resolve(strict=True)
    assert workspace.is_relative_to(root / 'workspace')
    outputs = []
    for item in manifest['outputs']:
        path = (workspace / item['path']).resolve(strict=True)
        assert path.is_relative_to(workspace)
        raw = path.read_bytes(); tracked[path] = audit.sha(raw)
        assert audit.sha(raw) == item['sha256'] and len(raw) == item['sizeBytes']
        outputs.append({key: item[key] for key in ('path', 'sha256', 'sizeBytes', 'mediaType')})
    assert [{key: item[key] for key in ('path', 'sha256', 'sizeBytes')} for item in outputs] == seed['outputs']
    manifest_path = workspace / '.workwise/deliverables' / project['id'] / run['id'] / 'manifest.json'
    manifest_raw = manifest_path.read_bytes(); tracked[manifest_path] = audit.sha(manifest_raw)
    assert json.loads(manifest_raw) == manifest
    old = audit.old_verification(db, project['id'], manifest['id'], [('engineering_projects', project), ('engineering_manifests', manifest), ('engineering_runs', run), ('engineering_datasets', dataset), ('engineering_analyses', analysis)])
    report = {'schemaVersion': 1, 'status': 'passed-historical-pre-gui-baseline', 'fixtureOnly': True, 'productionKpi': False,
              'checkedAt': datetime.now(timezone.utc).isoformat(), 'projectId': project['id'], 'manifestId': manifest['id'],
              'sourcePackageHead': seed['sourcePackageHead'], 'sourcePackageAsarSha256': seed['sourcePackageAsarSha256'],
              'closedOriginalDatabaseSha256': tracked[original], 'seedClosedDatabaseSha256Matched': tracked[original] == seed['closedDatabaseSha256'],
              'sourceAndReplayTablesAbsent': True, 'businessRowHashes': business, 'outputs': outputs, 'publishedManifestSha256': audit.sha(manifest_raw),
              'oldFiveCheckVerification': old}
finally:
    db.close()
audit.closed(root, files)
assert all(path.exists() and audit.sha(path.read_bytes()) == digest for path, digest in tracked.items())
assert set(files) == {Path(str(original) + suffix) for suffix in ('', '-wal', '-shm', '-journal') if Path(str(original) + suffix).exists()}
report['originalFilesAndClosedStateUnchanged'] = True
audit.dump(output / 'private-integrity.json', {str(path): digest for path, digest in tracked.items()})
audit.dump(output / 'public-summary.json', report)
print(json.dumps(report, ensure_ascii=False))
