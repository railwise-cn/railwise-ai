#!/usr/bin/env python3
"""Selected synthetic package audit. Never opens the original SQLite database."""
import argparse
import csv
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
from datetime import datetime, timezone
from xml.etree import ElementTree as ET
from zipfile import ZipFile

BASE = Path(__file__).resolve().parent
ROOT = Path('/private/tmp/railwise-survey-b193fc7')
HEAD = 'b193fc70d6363dc768e715087ca9c0d9975158c9'
DB_RELATIVE = 'home/.workwise/runtime/engineering/engineering.sqlite3'
BUSINESS_TABLES = ('engineering_projects', 'engineering_manifests', 'engineering_runs', 'engineering_datasets', 'engineering_analyses', 'engineering_charts')


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, BASE / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


legacy = module('legacy', 'legacy-monitoring-helpers.py')
validator = module('validator', 'replay-event-validator.py')
sha = legacy.sha


def dump(path, value):
    with path.open('x', encoding='utf8') as handle:
        os.chmod(handle.name, 0o600)
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write('\n')


def js_hash(value, canonical=False):
    code = "const fs=require('node:fs'),crypto=require('node:crypto'); const v=JSON.parse(fs.readFileSync(0,'utf8')); const c=x=>Array.isArray(x)?'['+x.map(c).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+c(x[k])).join(',')+'}':JSON.stringify(x); process.stdout.write(crypto.createHash('sha256').update(" + ('c(v)' if canonical else 'JSON.stringify(v)') + ").digest('hex'));"
    result = subprocess.run(['node', '-e', code], input=json.dumps(value, ensure_ascii=False, allow_nan=False), text=True, capture_output=True, check=True, timeout=15)
    assert re.fullmatch('[a-f0-9]{64}', result.stdout)
    return result.stdout


def closed(root, files):
    processes = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True, check=True)
    assert not any(str(root / 'Applications') + '/' in line and '/Contents/' in line for line in processes.stdout.splitlines()), 'candidate application or packaged child still running'
    handles = subprocess.run(['lsof', '-t', *map(str, files)], capture_output=True, text=True)
    assert handles.returncode == 1 and not handles.stdout.strip(), 'original SQLite files still have open handles'


def local(element, name):
    return [child for child in element if child.tag.rsplit('}', 1)[-1] == name]


def text(element, name):
    node = next((child for child in element.iter() if child.tag.rsplit('}', 1)[-1] == name), None)
    return ''.join(node.itertext()) if node is not None else ''


def tabular(raw, name, requested):
    if name.lower().endswith('.csv'):
        decoded = raw.decode('utf-8-sig')
        # The selected fixtures have no multiline quoted fields or ambiguous encodings.
        lines = [line for line in decoded.splitlines() if line.strip()]
        parsed = list(csv.reader(lines))
        return [{header.strip(): row[index] if index < len(row) else '' for index, header in enumerate(parsed[0])} for row in parsed[1:]]
    assert name.lower().endswith('.xlsx'), 'only declared CSV/XLSX fixtures are supported'
    rows = []
    with ZipFile(io.BytesIO(raw)) as archive:
        assert archive.testzip() is None
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = [''.join(node.itertext()) for node in local(ET.fromstring(archive.read('xl/sharedStrings.xml')), 'si')]
        for sheet in sorted(archive.namelist()):
            if not re.fullmatch(r'xl/worksheets/sheet\d+\.xml', sheet):
                continue
            table = []
            for row in ET.fromstring(archive.read(sheet)).iter():
                if row.tag.rsplit('}', 1)[-1] != 'row':
                    continue
                cells = {}
                for cell in local(row, 'c'):
                    letters = re.match(r'([A-Z]+)\d+', cell.attrib['r'])[1]
                    index = 0
                    for letter in letters:
                        index = index * 26 + ord(letter) - 64
                    value = text(cell, 'v') if cell.attrib.get('t') != 'inlineStr' else text(cell, 'is')
                    cells[index - 1] = shared[int(value)] if cell.attrib.get('t') == 's' else value
                table.append(cells)
            if not table:
                continue
            headers = {index: value.strip() or 'column_' + str(index + 1) for index, value in table[0].items()}
            mapping = {key: next((alias for alias in aliases if alias in headers.values()), None) for key, aliases in legacy.ALIASES.items()}
            mapping.update(requested or {})
            if not all(mapping.get(key) in headers.values() for key in ('point', 'timestamp', 'value')):
                continue
            rows.extend([{**{header: row.get(index, '') for index, header in headers.items()}, '__worksheet': sheet} for row in table[1:]])
    assert rows
    return rows


def normalize(rows, mapping, project, source_hash, dataset_id):
    output = []
    for index, row in enumerate(rows):
        value = legacy.number(row.get(mapping.get('value')))
        point = row.get(mapping.get('point'), '')
        timestamp = row.get(mapping.get('timestamp'), '')
        assert value is not None and point and timestamp, 'selected fixture contains an invalid observation'
        legacy.time(timestamp)
        observation = {'schemaVersion': 1, 'id': f'obs_{source_hash[:12]}_{index}', 'projectId': project['id'], 'datasetId': dataset_id,
                       'monitoringItem': row.get(mapping.get('monitoringItem')) or project['monitoringType'], 'point': point,
                       'timestamp': timestamp, 'value': value, 'unit': row.get(mapping['unit'], '') if mapping.get('unit') else project['unit'],
                       'sourceRow': index + 2, 'sourceFields': row}
        for key in ('cumulative', 'rate'):
            if mapping.get(key):
                optional = legacy.number(row.get(mapping[key]))
                if optional is not None:
                    observation[key] = optional
        output.append(observation)
    return output


def arithmetic(observations, project):
    grouped = {}
    for row in observations:
        grouped.setdefault((row['monitoringItem'], row['point']), []).append(row)
    result = []
    for (item, point), rows in grouped.items():
        rows = sorted(rows, key=lambda row: legacy.time(row['timestamp']))
        assert len({legacy.time(row['timestamp']) for row in rows}) == len(rows), 'tie-order fixture requires a separate expected outcome'
        first, last = rows[0], rows[-1]
        record = {'monitoringItem': item, 'point': point, 'currentValue': last['value']}
        change = None
        if len(rows) > 1:
            previous = rows[-2]
            change = last.get('cumulative', last['value']) - first.get('cumulative', first['value'])
            interval_days = (legacy.time(last['timestamp']) - legacy.time(previous['timestamp'])).total_seconds() / 86400
            assert interval_days > 0
            record.update(previousValue=previous['value'], cumulativeChange=change, changeRate=(last['value'] - previous['value']) / interval_days)
        threshold = project['thresholds'].get(item, project['thresholds'].get('default'))
        record.update(trend='unknown' if change is None else 'stable' if abs(change) < 1e-9 else 'rising' if change > 0 else 'falling',
                      anomaly=abs(change or 0) > (threshold if threshold is not None else float('inf')),
                      thresholdStatus='unresolved' if threshold is None else 'alarm' if abs(last['value']) >= threshold else 'warning' if abs(last['value']) >= threshold * .8 else 'normal')
        result.append(record)
    return result


def replay_events(db, project_id, manifest_id, analysis, dataset, source):
    rows = db.execute('SELECT * FROM engineering_monitoring_replay_events WHERE project_id=? AND manifest_id=? ORDER BY sequence', (project_id, manifest_id)).fetchall()
    by_attempt, output = {}, []
    for row in rows:
        event = validator.strict_json(row['data_json'])
        assert sha(row['data_json'].encode()) == row['record_hash']
        assert (event['id'], event['projectId'], event['manifestId'], event['phase']) == (row['attempt_id'], project_id, manifest_id, row['phase'])
        by_attempt.setdefault(row['attempt_id'], {})[row['phase']] = (row, event)
    for attempt_id, phases in by_attempt.items():
        assert 'started' in phases
        began_row, began = phases['started']
        item = {'id': attempt_id, 'startedAt': began['startedAt'], 'startSequence': began_row['sequence'], 'startHash': began_row['record_hash'], 'status': 'incomplete'}
        if 'finished' in phases:
            ended_row, ended = phases['finished']
            result = ended['result']
            assert ended['previousHash'] == began_row['record_hash'] and ended['resultHash'] == js_hash(result)
            validator.validate_result(result, ended)
            assert legacy.time(result['checkedAt']) >= legacy.time(began['startedAt'])
            assert result['projectId'] == project_id and result['manifestId'] == manifest_id
            for evidence in result['analyses']:
                assert evidence['analysisId'] == analysis['id'] and evidence['datasetId'] == dataset['id']
                assert evidence['algorithmVersion'] == analysis['algorithmVersion'] and evidence['inputHash'] == analysis['inputHash']
                assert evidence['storedResultsHash'] == js_hash(analysis['results'], True)
                if evidence['status'] == 'passed':
                    assert source is not None
                    assert evidence['sourceFileHash'] == source['source_hash'] and evidence['sourceContextHash'] == source['context_hash']
            if result['status'] == 'passed':
                assert result['execution']['runtimeVersion'] == '0.5.0'
            item.update(status=result['status'], reasonCode=result['reasonCode'], checkedAt=result['checkedAt'], finishSequence=ended_row['sequence'], finishHash=ended_row['record_hash'], resultHash=ended['resultHash'], result=result)
        output.append(item)
    assert output, 'no recorded package replay attempts for selected manifest'
    return output


def old_verification(db, project_id, manifest_id, records):
    summaries, raw_rows = [], []
    for row in db.execute('SELECT * FROM engineering_verification_attempts WHERE project_id=? AND manifest_id=? ORDER BY sequence', (project_id, manifest_id)):
        raw_rows.append(dict(row))
        assert sha(row['data_json'].encode()) == row['record_hash']
        terminal = json.loads(row['data_json'])
        assert terminal['id'] == row['id'] and terminal['projectId'] == project_id and terminal['manifestId'] == manifest_id
        events = [dict(item) for item in db.execute('SELECT * FROM engineering_verification_events WHERE attempt_id=? ORDER BY sequence', (row['id'],))]
        assert [event['phase'] for event in events] == ['started', 'finished']
        raw_rows.extend(events)
        for event in events:
            assert sha(event['data_json'].encode()) == event['record_hash']
        start, finish = [json.loads(event['data_json']) for event in events]
        assert start['attemptId'] == finish['attemptId'] == row['id']
        assert start['previousHash'] is None and finish['previousHash'] == events[0]['record_hash']
        assert finish['terminalRecordHash'] == row['record_hash'] and finish['terminalId'] == row['id']
        assert terminal['startedAt'] == start['occurredAt'] and terminal['completedAt'] == finish['occurredAt']
        if terminal['outcome'] == 'passed':
            legacy.attempt_bindings_check(terminal['bindings'], records)
            assert terminal['bindingStable'] and terminal['verification']['valid']
            checks = terminal['verification']['checks']
            assert len(checks) == 5 and {item['id']: item['status'] for item in checks} == {'manifest': 'passed', 'outputs': 'passed', 'inputs': 'passed', 'surveyReplay': 'not-applicable', 'sources': 'not-applicable'}
        summaries.append({'id': row['id'], 'outcome': terminal['outcome'], 'recordHash': row['record_hash'], 'startedAt': terminal['startedAt'], 'completedAt': terminal['completedAt']})
    all_start_rows = db.execute("SELECT * FROM engineering_verification_events WHERE phase='started'").fetchall()
    incomplete = []
    for row in all_start_rows:
        event = json.loads(row['data_json'])
        if event.get('projectId') != project_id or event.get('manifestId') != manifest_id:
            continue
        if row['attempt_id'] not in {item['id'] for item in summaries}:
            assert sha(row['data_json'].encode()) == row['record_hash']
            assert db.execute("SELECT count(*) FROM engineering_verification_events WHERE attempt_id=? AND phase='finished'", (row['attempt_id'],)).fetchone()[0] == 0
            raw_rows.append(dict(row)); incomplete.append({'id': row['attempt_id'], 'recordHash': row['record_hash']})
    return {'attempts': summaries, 'incompleteStarts': incomplete, 'allSelectedRowsHash': legacy.typed_hash(raw_rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=('before', 'afterrestart'), required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--asar', required=True)
    parser.add_argument('--before-summary', type=Path)
    for label in ('csv', 'xlsx'):
        for field in ('project', 'manifest', 'source'):
            parser.add_argument('--' + label + '-' + field, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    assert output.is_relative_to(BASE) and not output.exists()
    assert re.fullmatch('[a-f0-9]{64}', args.asar)
    before = json.loads(args.before_summary.read_text()) if args.before_summary else None
    assert args.phase == 'before' or before and before['status'] == 'passed-selected-package-replay-audit'
    tracked = {}
    def read(path):
        path = path.resolve(strict=True)
        assert path.is_relative_to(ROOT), 'reading outside isolated candidate root'
        raw = path.read_bytes()
        if path in tracked:
            assert tracked[path] == sha(raw)
        tracked[path] = sha(raw)
        return raw
    seed = json.loads(read(ROOT / 'evidence/synthetic-historical-monitoring-seed.json'))
    assert seed['fixtureOnly'] and not seed['realUserData'] and seed['oldOriginalSourceTableAbsent']
    assert seed['candidateRoot'] == str(ROOT) and seed['sourcePackageHead'] == '43689493ab586c8d65bae729cfd291f3c813f679'
    historical_baseline = json.loads((BASE / 'historical-before-gui/public-summary.json').read_text())
    assert historical_baseline['status'] == 'passed-historical-pre-gui-baseline' and historical_baseline['projectId'] == seed['projectId']
    package = json.loads(read(ROOT / 'evidence/package.json'))
    assert package['sourceHead'] == HEAD and package['asarSha256'] == args.asar
    asars = list((ROOT / 'Applications').glob('*.app/Contents/Resources/app.asar'))
    assert len(asars) == 1 and sha(read(asars[0])) == args.asar
    original = ROOT / DB_RELATIVE
    originals = [Path(str(original) + suffix) for suffix in ('', '-wal', '-shm', '-journal') if Path(str(original) + suffix).exists()]
    assert original in originals
    closed(ROOT, originals)
    output.mkdir(mode=0o700)
    copied = output / 'private-copied-originals'; copied.mkdir(mode=0o700)
    for path in originals:
        with (copied / path.name).open('xb') as handle:
            os.chmod(handle.name, 0o600); handle.write(read(path))
    closed(ROOT, originals)
    copied_db = sqlite3.connect((copied / original.name).as_uri() + '?mode=rw', uri=True)
    copied_db.execute('PRAGMA query_only=ON')
    assert copied_db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    snapshot = output / 'private-engineering.sqlite3'
    with snapshot.open('xb'):
        snapshot.chmod(0o600)
    backup = sqlite3.connect(snapshot); copied_db.backup(backup); backup.close(); copied_db.close()
    db = sqlite3.connect(snapshot.as_uri() + '?mode=ro&immutable=1', uri=True); db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    report = {'schemaVersion': 1, 'sourceHead': HEAD, 'packageAsarSha256': args.asar, 'phase': args.phase,
              'checkedAt': datetime.now(timezone.utc).isoformat(), 'fixtureOnly': True, 'productionKpi': False,
              'status': 'not-completed', 'projects': [], 'guiRestartVerifiedByScript': False}
    try:
        selected = [('historical', seed['projectId'], seed['manifestId'], None)] + [(label, getattr(args, label + '_project'), getattr(args, label + '_manifest'), Path(getattr(args, label + '_source'))) for label in ('csv', 'xlsx')]
        project_ids = {entry[1] for entry in selected}
        assert len(project_ids) == 3
        assert {row[0] for row in db.execute('SELECT id FROM engineering_projects')} == project_ids, 'isolated database contains unexpected projects; do not export a whole-database report'
        # The validator checks all events only after the copy is proven to contain exactly the selected synthetic projects.
        metric = validator.aggregate(db, datetime(2000, 1, 1, tzinfo=timezone.utc), datetime(2100, 1, 1, tzinfo=timezone.utc))
        assert metric['status'] == 'measured'
        assert not {row[0] for row in db.execute('SELECT DISTINCT project_id FROM engineering_monitoring_replay_events')} - project_ids
        report['selectedRecordedReplayCounts'] = metric['counts']
        def one(table, identity):
            row = db.execute('SELECT * FROM ' + table + ' WHERE id=?', (identity,)).fetchone()
            assert row
            value = json.loads(row['data_json'])
            assert value['id'] == identity
            for sql_key, json_key in (('project_id', 'projectId'), ('revision', 'revision'), ('dataset_id', 'datasetId')):
                if sql_key in row.keys():
                    assert row[sql_key] == value[json_key]
            return value, dict(row)
        for label, project_id, manifest_id, source_path in selected:
            project, project_sql = one('engineering_projects', project_id)
            manifest, manifest_sql = one('engineering_manifests', manifest_id)
            assert manifest['projectId'] == project_id and manifest['reviewStatus'] == 'draft' and manifest['validation']['valid']
            assert len(manifest['inputDatasets']) == len(manifest['analyses']) == 1
            dataset, dataset_sql = one('engineering_datasets', manifest['inputDatasets'][0]['id'])
            analysis, analysis_sql = one('engineering_analyses', manifest['analyses'][0])
            run, run_sql = one('engineering_runs', manifest['runId'])
            assert run['projectId'] == dataset['projectId'] == analysis['projectId'] == project_id
            assert run['datasetId'] == dataset['id'] == analysis['datasetId'] and run['analysisId'] == analysis['id']
            assert analysis['algorithmVersion'] == 'workwise-engineering-2'
            assert analysis['inputHash'] == js_hash({'project': project, 'observations': dataset['observations']})
            assert dataset['sourceFileHash'] == manifest['inputDatasets'][0]['hash']
            workspace = Path(project['workspace']).resolve(strict=True)
            assert workspace.is_relative_to(ROOT / 'workspace')
            source = db.execute('SELECT * FROM engineering_monitoring_sources WHERE dataset_id=?', (dataset['id'],)).fetchone()
            source_hashes = None
            if label == 'historical':
                assert source is None and dataset['id'] == seed['datasetId'] and analysis['id'] == seed['analysisId']
                assert dataset['sourceFileHash'] == seed['sourceFileHash'] and analysis['inputHash'] == seed['inputHash']
                assert [{key: item[key] for key in ('path', 'sha256', 'sizeBytes')} for item in manifest['outputs']] == seed['outputs']
            else:
                assert source and source['project_id'] == project_id
                original_bytes = read(source_path)
                assert original_bytes == source['source_bytes']
                assert sha(original_bytes) == dataset['sourceFileHash'] == source['source_hash']
                assert sha(source['context_json'].encode()) == source['context_hash']
                context = json.loads(source['context_json'])
                assert context['datasetId'] == dataset['id'] and context['project']['id'] == project_id
                assert context['sourceFileName'] == dataset['sourceFileName'] and context['sourceFileHash'] == dataset['sourceFileHash']
                assert context['fieldMapping'] == dataset['fieldMapping']
                rows = tabular(original_bytes, context['sourceFileName'], context['requestedMapping'])
                normalized = normalize(rows, context['fieldMapping'], context['project'], source['source_hash'], dataset['id'])
                assert len(rows) == dataset['rowCount'] and len(normalized) == dataset['observationCount']
                assert normalized == dataset['observations'], 'complete normalized observation differs from retained original/context'
                source_hashes = {'sourceFileHash': source['source_hash'], 'sourceContextHash': source['context_hash'], 'sourceSizeBytes': len(original_bytes), 'contextSizeBytes': len(source['context_json'].encode()), 'completeNormalizedObservationsMatch': True}
            expected = arithmetic(dataset['observations'], project)
            assert expected == analysis['results'], 'complete analysis differs from independent binary arithmetic'
            record_pairs = [('engineering_manifests', manifest), ('engineering_projects', project), ('engineering_runs', run), ('engineering_datasets', dataset), ('engineering_analyses', analysis)]
            business = {table: legacy.typed_hash(value) for table, value in [('engineering_projects', project_sql), ('engineering_manifests', manifest_sql), ('engineering_runs', run_sql), ('engineering_datasets', dataset_sql), ('engineering_analyses', analysis_sql)]}
            assert len(manifest['charts']) == 1 and len(manifest['outputs']) == 4
            chart, chart_sql = one('engineering_charts', manifest['charts'][0]['id']); business['engineering_charts'] = legacy.typed_hash(chart_sql)
            files, geometry = [], None
            for item in manifest['outputs']:
                path = (workspace / item['path']).resolve(strict=True)
                assert path.is_relative_to(workspace)
                raw = read(path)
                assert sha(raw) == item['sha256'] and len(raw) == item['sizeBytes']
                if path.suffix == '.svg':
                    legacy.chart_binding_check(manifest['charts'][0], chart, analysis, item, raw)
                    geometry = legacy.chart_check(raw, dataset['observations'])
                elif path.suffix == '.xlsx':
                    worksheets = legacy.sheets(raw)
                    result_rows = next(sheet for sheet in worksheets if sheet and 'cumulativeChange' in sheet[0] and 'trend' in sheet[0])
                    legacy.compare_analysis(expected, result_rows)
                    normalized_rows = next(sheet for sheet in worksheets if sheet and 'timestamp' in sheet[0] and 'sourceRow' in sheet[0])
                    assert len(normalized_rows) == len(dataset['observations'])
                    for row, obs in zip(normalized_rows, dataset['observations']):
                        for key in ('value', 'cumulative', 'rate'):
                            assert legacy.number(row[key]) == obs.get(key)
                        for key in ('monitoringItem', 'point', 'timestamp', 'unit'):
                            assert row[key] == obs[key]
                elif path.suffix == '.docx':
                    with ZipFile(io.BytesIO(raw)) as archive:
                        assert archive.testzip() is None
                        report_text = ''.join(ET.fromstring(archive.read('word/document.xml')).itertext())
                    legacy.report_metadata_check(report_text, project, dataset, analysis)
                elif path.suffix == '.pdf':
                    result = subprocess.run(['node', str(BASE / 'pdf-text.mjs'), str(path)], capture_output=True, text=True, check=True, timeout=45)
                    legacy.report_metadata_check(json.loads(result.stdout)['text'], project, dataset, analysis)
                else:
                    raise AssertionError('unexpected selected output type')
                files.append({key: item[key] for key in ('path', 'sha256', 'sizeBytes', 'mediaType')})
            assert geometry
            published = workspace / '.workwise/deliverables' / project_id / run['id'] / 'manifest.json'
            assert json.loads(read(published)) == manifest
            events = replay_events(db, project_id, manifest_id, analysis, dataset, source)
            old = old_verification(db, project_id, manifest_id, record_pairs)
            replay_ids = {item['id'] for item in events}
            assert not replay_ids.intersection(item['id'] for item in old['attempts'])
            if label == 'historical':
                assert business == historical_baseline['businessRowHashes'], 'new package changed old-package business row bytes'
                assert files == historical_baseline['outputs'], 'new package changed old-package output bytes'
                old_ids = {item['id']: item for item in old['attempts']}
                assert all(old_ids.get(item['id']) == item for item in historical_baseline['oldFiveCheckVerification']['attempts'])
                assert all(item['status'] == 'not-evaluated' and item['reasonCode'] == 'source-unavailable' for item in events)
            else:
                assert any(item['status'] == 'passed' for item in events)
            summary = {'format': label, 'ids': {'project': project_id, 'manifest': manifest_id, 'dataset': dataset['id'], 'analysis': analysis['id'], 'run': run['id']},
                       'source': source_hashes, 'businessRowHashes': business, 'expected': expected, 'outputs': files, 'chart': geometry,
                       'reviewStatus': manifest['reviewStatus'], 'replayAttempts': events, 'oldFiveCheckVerification': old}
            if before:
                previous = next(item for item in before['projects'] if item['format'] == label)
                assert before['sourceHead'] == HEAD and before['packageAsarSha256'] == args.asar
                for key in ('ids', 'source', 'businessRowHashes', 'expected', 'outputs', 'chart', 'reviewStatus'):
                    assert summary[key] == previous[key], 'restart changed selected source, business records or outputs'
                current = {item['id']: item for item in events}
                assert all(current.get(item['id']) == item for item in previous['replayAttempts']), 'restart lost or altered replay evidence'
                new = [item for item in events if item['id'] not in {old['id'] for old in previous['replayAttempts']}]
                expected_status = 'not-evaluated' if label == 'historical' else 'passed'
                assert any(item['status'] == expected_status and legacy.time(item['startedAt']) > legacy.time(before['checkedAt']) for item in new), 'missing selected replay performed after before audit'
                previous_old = previous['oldFiveCheckVerification']
                keyed_old = {item['id']: item for item in old['attempts']}
                assert all(keyed_old.get(item['id']) == item for item in previous_old['attempts'])
                summary['oldFiveCheckRowsUnchangedSinceBefore'] = old == previous_old
                summary['newReplayAttemptIdsAfterBefore'] = [item['id'] for item in new]
            report['projects'].append(summary)
        recovered = []
        for project in report['projects']:
            if project['format'] == 'historical':
                continue
            events = project['replayAttempts']
            for failure in events:
                if failure['status'] != 'failed' or failure.get('reasonCode') != 'prerequisite-failed':
                    continue
                later = [item for item in events if item['status'] == 'passed' and legacy.time(item['startedAt']) > legacy.time(failure['checkedAt'])]
                if later:
                    recovered.append({'format': project['format'], 'failedAttemptId': failure['id'], 'laterPassedAttemptId': later[0]['id']})
        assert recovered, 'missing retained prerequisite failure followed by a successful retry'
        report['retainedFailureAndSuccessfulRetry'] = recovered
        report['status'] = 'passed-selected-package-replay-audit'
    except Exception as error:
        report['status'] = 'failed'
        dump(output / 'private-error.json', {'class': type(error).__name__, 'message': str(error)})
        raise
    finally:
        db.close()
        current_files = [Path(str(original) + suffix) for suffix in ('', '-wal', '-shm', '-journal') if Path(str(original) + suffix).exists()]
        stable = set(current_files) == set(originals) and all(path.exists() and sha(path.read_bytes()) == digest for path, digest in tracked.items())
        try:
            closed(ROOT, current_files)
        except Exception:
            stable = False
        report['originalFilesAndClosedStateUnchanged'] = stable
        if not stable:
            report['status'] = 'failed'
        report['limitations'] = ['Selected synthetic fixtures only; not a source authenticity, professional approval or production KPI claim.',
                                 'GUI operations and actual restart are separate operator evidence; script checks records observed after those actions.',
                                 'Full normalized originals and complete arithmetic results checked; workbook values, document metadata and SVG geometry checked, not pixel rendering.',
                                 'Original database is only byte-copied after process/handle guards; SQLite opens only private copies. No full database appears in this public summary.']
        dump(output / 'private-integrity.json', {str(path): digest for path, digest in tracked.items()})
        dump(output / 'public-summary.json', report)
    assert report['status'] == 'passed-selected-package-replay-audit'
    print(json.dumps({'status': report['status'], 'phase': args.phase, 'selectedProjects': 3, 'originalFilesUnchanged': True}))


if __name__ == '__main__':
    main()
