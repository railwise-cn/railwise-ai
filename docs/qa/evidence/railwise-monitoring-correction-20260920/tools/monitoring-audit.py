#!/usr/bin/env python3
"""Explicit selected monitoring audit, independent arithmetic, no GUI execution."""
import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
from datetime import datetime, timezone
from zipfile import ZipFile
from xml.etree import ElementTree as ET

N = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
SVG = {'s': 'http://www.w3.org/2000/svg'}
ALIASES = {'monitoringItem': ['监测项', 'monitoringItem'], 'point': ['测点', 'point'], 'timestamp': ['时间', 'timestamp', 'time'], 'value': ['数值', 'value'], 'unit': ['单位', 'unit'], 'cumulative': ['累计变化', 'cumulative'], 'rate': ['速率', 'rate']}
PDF_HELPER = Path(__file__).with_name('monitoring-pdf-text.mjs')


def sha(raw): return hashlib.sha256(raw).hexdigest()
def time(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    # Candidate contract: date-only and unzoned ISO timestamps explicitly mean UTC.
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
def close(a, b): return math.isclose(float(a), float(b), rel_tol=1e-10, abs_tol=1e-10)
def dump(path, value):
    with path.open('x') as handle:
        os.chmod(handle.name, 0o600); json.dump(value, handle, ensure_ascii=False, indent=2); handle.write('\n')


def sheets(raw):
    result = []
    with ZipFile(io.BytesIO(raw)) as zipped:
        assert zipped.testzip() is None
        shared = []
        if 'xl/sharedStrings.xml' in zipped.namelist():
            shared = [''.join(si.itertext()) for si in ET.fromstring(zipped.read('xl/sharedStrings.xml'))]
        for name in sorted(zipped.namelist()):
            if not re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name): continue
            parsed = []
            for row in ET.fromstring(zipped.read(name)).findall('m:sheetData/m:row', N):
                cells = {}
                for cell in row:
                    column = re.match(r'([A-Z]+)', cell.attrib['r'])[1]
                    col = 0
                    for letter in column: col = col * 26 + ord(letter) - 64
                    if cell.attrib.get('t') == 's': value = shared[int(cell.find('m:v', N).text)]
                    elif cell.attrib.get('t') == 'inlineStr': value = ''.join(cell.find('m:is', N).itertext())
                    else:
                        v = cell.find('m:v', N); value = v.text if v is not None else ''
                    cells[col - 1] = value or ''
                parsed.append(cells)
            if not parsed: continue
            headers = parsed[0]
            result.append([{header: row.get(index, '') for index, header in headers.items()} for row in parsed[1:]])
    return result


def number(raw):
    if raw is None or str(raw).strip() == '': return None
    value = float(raw); assert math.isfinite(value); return value


def source_rows(path):
    raw = path.read_bytes()
    groups = sheets(raw) if path.suffix == '.xlsx' else [list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))]
    output = []
    for rows in groups:
        if not rows: continue
        mapping = {key: next((name for name in aliases if name in rows[0]), None) for key, aliases in ALIASES.items()}
        if not all(mapping[key] for key in ('point', 'timestamp', 'value')): continue
        for row in rows:
            item = {key: row.get(column) if column else None for key, column in mapping.items()}
            for key in ('value', 'cumulative', 'rate'): item[key] = number(item[key])
            assert item['value'] is not None and time(item['timestamp']).tzinfo
            output.append(item)
    assert output
    return output


def independent(rows):
    grouped = {}
    for row in rows: grouped.setdefault((row['monitoringItem'], row['point']), []).append(row)
    expected = []
    for (item, point), samples in grouped.items():
        samples = sorted(samples, key=lambda row: time(row['timestamp']))
        assert len(samples) >= 2
        first, previous, last = samples[0], samples[-2], samples[-1]
        days = (time(last['timestamp']) - time(previous['timestamp'])).total_seconds() / 86400
        assert days > 0
        change = (last['value'] if last['cumulative'] is None else last['cumulative']) - (first['value'] if first['cumulative'] is None else first['cumulative'])
        expected.append({'monitoringItem': item, 'point': point, 'currentValue': last['value'], 'previousValue': previous['value'], 'cumulativeChange': change, 'changeRate': (last['value'] - previous['value']) / days, 'trend': 'stable' if abs(change) < 1e-9 else 'rising' if change > 0 else 'falling'})
    return expected


def compare_analysis(expected, actual):
    assert len(expected) == len(actual)
    keyed = {(row['monitoringItem'], row['point']): row for row in actual}
    assert len(keyed) == len(actual)
    for row in expected:
        other = keyed[(row['monitoringItem'], row['point'])]
        for key, value in row.items():
            assert close(value, other[key]) if isinstance(value, (float, int)) else value == other[key], 'analysis differs from source arithmetic'


def chart_check(raw, rows):
    svg = ET.fromstring(raw)
    groups = svg.findall('.//s:g[@data-series-index]', SVG)
    expected = {}
    for row in rows: expected.setdefault(row['point'], []).append(row)
    assert len(groups) == len(expected)
    for group in groups:
        title = group.find('s:title', SVG).text
        point = next(point for point in expected if f' / {point} (' in title)
        samples = sorted(expected[point], key=lambda row: time(row['timestamp']))
        circles = group.findall('s:circle[@data-role="observation"]', SVG)
        assert len(circles) == len(samples)
        positions = []
        for circle, sample in zip(circles, samples):
            tooltip = circle.find('s:title', SVG).text
            assert sample['timestamp'] in tooltip and point in tooltip and sample['unit'] in tooltip
            value_text = tooltip.split(' · ')[-1].split()[0]
            assert close(value_text, sample['value'])
            positions.append((float(circle.attrib['cx']), float(circle.attrib['cy'])))
        lines = group.findall('s:polyline[@data-role="trend-line"]', SVG)
        assert len(lines) == 1
        assert [tuple(map(float, pair.split(','))) for pair in lines[0].attrib['points'].split()] == positions
        if len(samples) == 3:
            ratio = (positions[1][0] - positions[0][0]) / (positions[2][0] - positions[0][0])
            expected_ratio = (time(samples[1]['timestamp']) - time(samples[0]['timestamp'])).total_seconds() / (time(samples[2]['timestamp']) - time(samples[0]['timestamp'])).total_seconds()
            assert abs(ratio - expected_ratio) < 1e-5, 'chart time is not proportional'
        for index in range(1, len(samples)):
            assert positions[index][0] > positions[index - 1][0]
            assert (positions[index][1] - positions[index - 1][1]) * (samples[index]['value'] - samples[index - 1]['value']) < 0
    return {'series': len(groups), 'observations': len(rows), 'timeProportional': True, 'pointLinesSeparate': True}


def main():
    parser = argparse.ArgumentParser()
    for key in ('root', 'output', 'input-manifest'): parser.add_argument('--' + key, type=Path, required=True)
    for key in ('head', 'asar', 'csv-project', 'csv-manifest', 'xlsx-project', 'xlsx-manifest'): parser.add_argument('--' + key, required=True)
    parser.add_argument('--phase', choices=('before', 'afterrestart'), required=True)
    parser.add_argument('--before-summary', type=Path)
    parser.add_argument('--csv-source', default='synthetic-monitoring-two-points-irregular.csv')
    parser.add_argument('--xlsx-source', default='synthetic-monitoring-zero-blank.xlsx')
    parser.add_argument('--algorithm', default='workwise-engineering-2')
    args = parser.parse_args()
    root, output = args.root.resolve(strict=True), args.output.resolve()
    assert root.is_relative_to('/private/tmp') and output.is_relative_to('/private/tmp') and not output.exists()
    assert re.fullmatch('[0-9a-f]{40}', args.head) and re.fullmatch('[0-9a-f]{64}', args.asar)
    before = json.loads(args.before_summary.read_text()) if args.before_summary else None
    assert args.phase == 'before' or before and before['status'] == 'passed-selected-monitoring-checks'
    tracked = {}
    def read(path):
        path = path.resolve(strict=True); raw = path.read_bytes(); digest = sha(raw)
        if path in tracked: assert tracked[path] == digest
        tracked[path] = digest; return raw
    package = json.loads(read(root / 'evidence/package.json'))
    assert package['sourceHead'] == args.head and package['asarSha256'] == args.asar
    asars = list((root / 'Applications').glob('*.app/Contents/Resources/app.asar'))
    assert len(asars) == 1 and sha(read(asars[0])) == args.asar
    fixtures = json.loads(read(args.input_manifest))
    fingerprints = {entry['name']: entry['fingerprint'] for entry in fixtures['files']}
    source_db = root / 'home/.workwise/runtime/engineering/engineering.sqlite3'
    originals = [Path(str(source_db) + suffix) for suffix in ('', '-wal', '-shm', '-journal') if Path(str(source_db) + suffix).exists()]
    handles = subprocess.run(['lsof', '-t', *map(str, originals)], capture_output=True, text=True)
    assert handles.returncode == 1 and not handles.stdout.strip()
    output.mkdir(mode=0o700); copied = output / 'private-copied-originals'; copied.mkdir(mode=0o700)
    for file in originals:
        with (copied / file.name).open('xb') as handle:
            os.chmod(handle.name, 0o600); handle.write(read(file))
    copied_db = sqlite3.connect((copied / source_db.name).as_uri() + '?mode=rw', uri=True)
    copied_db.execute('PRAGMA query_only=ON'); assert copied_db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    consolidated = output / 'private-engineering.sqlite3'
    with consolidated.open('xb'): consolidated.chmod(0o600)
    backup = sqlite3.connect(consolidated); copied_db.backup(backup); backup.close(); copied_db.close()
    db = sqlite3.connect(consolidated.as_uri() + '?mode=ro&immutable=1', uri=True)
    db.execute('PRAGMA query_only=ON'); assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    def one(table, identity):
        record = db.execute('SELECT data_json FROM ' + table + ' WHERE id=?', (identity,)).fetchone(); assert record
        return json.loads(record[0])
    report = {'schemaVersion': 1, 'status': 'not-completed', 'sourceHead': args.head, 'packageAsarSha256': args.asar, 'phase': args.phase, 'checkedAt': datetime.now(timezone.utc).isoformat(), 'projects': [], 'guiRestartVerifiedByScript': False}
    try:
        for label in ('csv', 'xlsx'):
            project_id, manifest_id = getattr(args, label + '_project'), getattr(args, label + '_manifest')
            source = root / 'inputs' / getattr(args, label + '_source'); source_raw = read(source)
            assert {'sha256': sha(source_raw), 'sizeBytes': len(source_raw)} == fingerprints[source.name]
            rows = source_rows(source); expected = independent(rows)
            project = one('engineering_projects', project_id); manifest = one('engineering_manifests', manifest_id)
            assert manifest['projectId'] == project_id and manifest['reviewStatus'] == 'draft' and manifest['validation']['valid']
            assert len(manifest['inputDatasets']) == len(manifest['analyses']) == 1
            dataset = one('engineering_datasets', manifest['inputDatasets'][0]['id']); analysis = one('engineering_analyses', manifest['analyses'][0]); run = one('engineering_runs', manifest['runId'])
            assert dataset['projectId'] == analysis['projectId'] == run['projectId'] == project_id
            assert analysis['algorithmVersion'] == args.algorithm, 'unexpected analysis algorithm version'
            assert run['datasetId'] == analysis['datasetId'] == dataset['id'] and run['analysisId'] == analysis['id']
            assert dataset['sourceFileHash'] == manifest['inputDatasets'][0]['hash'] == sha(source_raw)
            calculated_input_hash = sha(json.dumps({'project': project, 'observations': dataset['observations']}, ensure_ascii=False, separators=(',', ':')).encode())
            assert analysis['inputHash'] == calculated_input_hash, 'analysis input binding differs'
            assert len(dataset['observations']) == dataset['observationCount'] == len(rows)
            for observed, original in zip(dataset['observations'], rows):
                for key, value in original.items():
                    assert observed.get(key) == value, 'normalized observation/blank/zero differs from source'
            compare_analysis(expected, analysis['results'])
            workspace = Path(project['workspace']).resolve(); assert workspace.is_relative_to(root)
            files, kinds, chart = [], set(), None
            for item in manifest['outputs']:
                path = (workspace / item['path']).resolve(); assert path.is_relative_to(workspace)
                raw = read(path); assert sha(raw) == item['sha256'] and len(raw) == item['sizeBytes']
                kinds.add(path.suffix)
                if path.suffix == '.xlsx':
                    worksheet_rows = sheets(raw)
                    result_rows = next(sheet for sheet in worksheet_rows if sheet and 'cumulativeChange' in sheet[0] and 'trend' in sheet[0])
                    compare_analysis(expected, result_rows)
                    normalized = next(sheet for sheet in worksheet_rows if sheet and 'timestamp' in sheet[0] and 'sourceRow' in sheet[0])
                    assert len(normalized) == len(rows)
                    for row, original in zip(normalized, rows):
                        for key in ('value', 'cumulative', 'rate'): assert number(row[key]) == original[key]
                elif path.suffix in ('.docx', '.pdf'):
                    if path.suffix == '.docx':
                        with ZipFile(io.BytesIO(raw)) as zipped:
                            assert zipped.testzip() is None
                            text = ''.join(ET.fromstring(zipped.read('word/document.xml')).itertext())
                    else:
                        result = subprocess.run(['node', str(PDF_HELPER), str(path)], capture_output=True, text=True, timeout=45)
                        assert result.returncode == 0
                        text = json.loads(result.stdout)['text']
                    compact = re.sub(r'\s+', '', text)
                    for row in expected:
                        trend = {'rising': '上升', 'falling': '下降', 'stable': '稳定'}[row['trend']]
                        pattern = re.escape(row['monitoringItem'] + '/' + row['point'] + ':')
                        pattern += r'当前=([+-]?[\d.]+)mm上期=([+-]?[\d.]+)mm累计=([+-]?[\d.]+)mm速率=([+-]?[\d.]+)mm/d趋势=' + trend
                        match = re.search(pattern, compact); assert match, 'report text lacks localized result values'
                        for value, key in zip(match.groups(), ('currentValue', 'previousValue', 'cumulativeChange', 'changeRate')): assert close(value, row[key])
                elif path.suffix == '.svg': chart = chart_check(raw, rows)
                files.append({key: item[key] for key in ('mediaType', 'sha256', 'sizeBytes')})
            assert kinds == {'.docx', '.pdf', '.xlsx', '.svg'} and chart
            attempts = []
            for identity, digest, raw in db.execute('SELECT id,record_hash,data_json FROM engineering_verification_attempts WHERE manifest_id=? ORDER BY sequence', (manifest_id,)):
                assert sha(raw.encode()) == digest
                terminal = json.loads(raw); assert terminal['projectId'] == project_id and terminal['manifestId'] == manifest_id
                assert terminal['id'] == identity and terminal['outcome'] in ('passed', 'failed', 'error')
                phases = {}
                for phase, event_hash, event_raw in db.execute('SELECT phase,record_hash,data_json FROM engineering_verification_events WHERE attempt_id=?', (identity,)):
                    assert sha(event_raw.encode()) == event_hash and phase not in phases
                    phases[phase] = (json.loads(event_raw), event_hash)
                assert set(phases) == {'started', 'finished'}
                began, ended = phases['started'][0], phases['finished'][0]
                assert began['projectId'] == project_id and began['manifestId'] == manifest_id and began['previousHash'] is None
                assert ended['previousHash'] == phases['started'][1] and ended['terminalRecordHash'] == digest and ended['terminalId'] == identity
                assert began['occurredAt'] == terminal['startedAt'] and ended['occurredAt'] == terminal['completedAt'] and time(ended['occurredAt']) >= time(began['occurredAt'])
                if terminal['outcome'] == 'passed':
                    assert terminal['bindingStable'] and terminal['verification']['valid'] and terminal['verification']['reviewStatus'] == 'draft'
                    assert len(terminal['verification']['checks']) == 5
                    assert {c['id']: c['status'] for c in terminal['verification']['checks']} == {'manifest': 'passed', 'outputs': 'passed', 'inputs': 'passed', 'surveyReplay': 'not-applicable', 'sources': 'not-applicable'}
                attempts.append({'id': identity, 'startedAt': terminal['startedAt'], 'outcome': terminal['outcome'], 'recordHash': digest})
            incomplete = []
            terminal_ids = {row['id'] for row in attempts}
            for identity, digest, raw in db.execute("SELECT attempt_id,record_hash,data_json FROM engineering_verification_events WHERE phase='started'"):
                event = json.loads(raw)
                if event.get('manifestId') != manifest_id or identity in terminal_ids: continue
                assert sha(raw.encode()) == digest and event['projectId'] == project_id and event['attemptId'] == identity and event['previousHash'] is None
                assert db.execute("SELECT count(*) FROM engineering_verification_events WHERE attempt_id=? AND phase='finished'", (identity,)).fetchone()[0] == 0
                incomplete.append({'id': identity, 'startedAt': event['occurredAt'], 'recordHash': digest})
            passed = [item for item in attempts if item['outcome'] == 'passed']
            assert len(passed) >= (2 if before else 1)
            item = {'format': label, 'ids': {'project': project_id, 'manifest': manifest_id, 'dataset': dataset['id'], 'analysis': analysis['id'], 'run': run['id']}, 'sourceSha256': sha(source_raw), 'expected': expected, 'outputs': files, 'analysisInputHash': analysis['inputHash'], 'algorithmVersion': analysis['algorithmVersion'], 'chart': chart, 'reviewStatus': 'draft', 'verificationAttempts': attempts, 'incompleteStarts': incomplete}
            if before:
                previous = next(row for row in before['projects'] if row['format'] == label)
                assert before['sourceHead'] == args.head and before['packageAsarSha256'] == args.asar
                for key in ('ids', 'sourceSha256', 'expected', 'outputs', 'analysisInputHash', 'algorithmVersion'): assert item[key] == previous[key], 'restart changed selected identities or output bytes'
                assert any(row['id'] not in {old['id'] for old in previous['verificationAttempts']} and time(row['startedAt']) >= time(before['checkedAt']) for row in passed)
            report['projects'].append(item)
        report['status'] = 'passed-selected-monitoring-checks'
    except Exception as error:
        report['status'] = 'failed'; dump(output / 'private-error.json', {'class': type(error).__name__, 'message': str(error)}); raise
    finally:
        db.close()
        report['allReadFilesUnchanged'] = all(path.exists() and sha(path.read_bytes()) == digest for path, digest in tracked.items())
        current_originals = [Path(str(source_db) + suffix) for suffix in ('', '-wal', '-shm', '-journal') if Path(str(source_db) + suffix).exists()]
        held = subprocess.run(['lsof', '-t', *map(str, current_originals)], capture_output=True, text=True)
        report['originalFileSetAndClosedStateStable'] = set(current_originals) == set(originals) and held.returncode == 1 and not held.stdout.strip()
        if not report['originalFileSetAndClosedStateStable']: report['allReadFilesUnchanged'] = False
        if not report['allReadFilesUnchanged']: report['status'] = 'failed'
        report['limitations'] = ['Selected synthetic records only; no professional approval or production KPI.', 'GUI restart and rendered visual checks are separate operator evidence.', 'DOCX/PDF numerical text, workbook values and SVG geometry checked; no pixel-based rendering claim.']
        dump(output / 'private-integrity.json', {str(path): digest for path, digest in tracked.items()})
        dump(output / 'public-summary.json', report)
    assert report['status'] == 'passed-selected-monitoring-checks'
    print(json.dumps({'status': report['status'], 'phase': args.phase, 'selectedProjects': 2, 'allReadFilesUnchanged': True}))


if __name__ == '__main__': main()
