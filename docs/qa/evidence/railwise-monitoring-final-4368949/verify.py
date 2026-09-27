#!/usr/bin/env python3
"""Read-only archive verification; never opens candidate databases or launches UI."""
import hashlib
import json
from pathlib import Path
import re
from datetime import datetime

ROOT = Path(__file__).resolve().parent
HEAD = '43689493ab586c8d65bae729cfd291f3c813f679'
ASAR = '11a060ec6a7c42385eed433a336967a91647251f51a07f0781302420b2f9e20c'


def load(name): return json.loads((ROOT / name).read_text())
def digest(raw): return hashlib.sha256(raw).hexdigest()
def instant(value): return datetime.fromisoformat(value.replace('Z', '+00:00'))


def main():
    manifest = load('archive-manifest.json')
    assert manifest['sourceHead'] == HEAD and manifest['installedAsarSha256'] == ASAR
    actual = {str(path.relative_to(ROOT)) for path in ROOT.rglob('*') if path.is_file()}
    assert actual == set(manifest['files']) | {'archive-manifest.json'}
    assert not any(path.is_symlink() for path in ROOT.rglob('*'))
    for name, metadata in manifest['files'].items():
        path = ROOT / name; raw = path.read_bytes()
        assert path.resolve().is_relative_to(ROOT) and path.is_file()
        assert len(raw) == metadata['sizeBytes'] and digest(raw) == metadata['sha256'], name
        assert not raw.startswith(b'SQLite format 3') and path.suffix not in ('.db', '.sqlite3', '.env')
        if path.suffix in ('.json', '.txt', '.md', '.py', '.mjs', '.csv', '.svg'):
            text = raw.decode()
            assert not re.search(r'\x2fUsers\x2f[^/]+/|\x2fvar\x2ffolders\x2f', text), name
            assert not re.search(r'private-[0-9a-f]{32,}|(?:sk-|ghp_)[A-Za-z0-9_-]{20,}|(?i:bearer\s+[A-Za-z0-9._-]{20,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', text), name
    for entry in load('source-copy-provenance.json'):
        assert digest((ROOT / entry['path']).read_bytes()) == entry['archiveSha256']
    before, after = load('audit/before.json'), load('audit/afterrestart.json')
    assert digest((ROOT / 'audit/before.json').read_bytes()) == 'a1ec51382a2cecb88a74e4d7d182483d713399ae92cfb873ff154c28a6ba6499'
    assert digest((ROOT / 'audit/afterrestart.json').read_bytes()) == '04a6fb7c2e6d6d85f1e487bdc6fde76e6546cd7c964372e26371f673f892dc2c'
    for summary in (before, after):
        assert summary['status'] == 'passed-selected-monitoring-checks'
        assert summary['sourceHead'] == HEAD and summary['packageAsarSha256'] == ASAR
        assert summary['allReadFilesUnchanged'] and summary['originalFileSetAndClosedStateStable']
        assert summary['guiRestartVerifiedByScript'] is False
        assert len(summary['projects']) == 2 and {item['format'] for item in summary['projects']} == {'csv', 'xlsx'}
    assert before['phase'] == 'before' and after['phase'] == 'afterrestart' and instant(after['checkedAt']) > instant(before['checkedAt'])
    for current in after['projects']:
        previous = next(item for item in before['projects'] if item['format'] == current['format'])
        for key in ('ids', 'sourceSha256', 'expected', 'outputs', 'analysisInputHash', 'algorithmVersion', 'chart', 'reviewStatus'):
            assert current[key] == previous[key]
        assert current['reviewStatus'] == 'draft' and current['algorithmVersion'] == 'workwise-engineering-2'
        assert current['chart']['rendererVersion'] == 'engineering-trend-2' and current['chart']['series'] == 2 and current['chart']['observations'] == 6
        assert not current['incompleteStarts'] and not previous['incompleteStarts']
        assert all(item['outcome'] == 'passed' for item in current['verificationAttempts'])
        expected_count = 2 if current['format'] == 'csv' else 4
        assert len(current['verificationAttempts']) == expected_count and len(previous['verificationAttempts']) == expected_count - 1
        attempts = {item['id']: item for item in current['verificationAttempts']}
        assert all(attempts.get(item['id']) == item for item in previous['verificationAttempts'])
        old_ids = {item['id'] for item in previous['verificationAttempts']}
        added = [item for item in current['verificationAttempts'] if item['id'] not in old_ids]
        assert len(added) == 1 and instant(added[0]['startedAt']) > instant(before['checkedAt'])
        assert len(current['outputs']) == 4
        for output in current['outputs']:
            raw = (ROOT / 'outputs' / current['format'] / Path(output['path']).name).read_bytes()
            assert len(raw) == output['sizeBytes'] and digest(raw) == output['sha256']
    package, install, cloud = load('package/package.json'), load('package/installation-context.json'), load('cloud/private-updater.json')
    assert package['sourceHead'] == install['sourceHead'] == cloud['sourceHead'] == HEAD
    assert package['asarSha256'] == install['installedAsarSha256'] == cloud['installedAsarSha256'] == cloud['targetAsarSha256'] == ASAR
    assert package['zipSha256'] == install['targetZipSha256'] == cloud['targetZipSha256']
    assert cloud['status'] == 'passed' and cloud['signature'] == cloud['stapledNotarization'] == 'verified'
    assert cloud['gatekeeperStatus'] == 'assessments enabled' and install['localGatekeeperStatus'] == 'assessments disabled'
    assert not cloud['productionTouched'] and not cloud['publicFeedUploaded']
    native = load('cloud/native-updater.json')
    assert native['status'] == 'passed' and native['baseVersion'] == '0.0.0' and native['targetVersion'] == '0.5.0'
    assert not native['browserOpened'] and native['userDataPreserved']
    assert [step['name'] for step in native['stages']] == ['base_started', 'update_available', 'download_completed', 'install_requested', 'target_relaunched', 'user_data_preserved']
    assert native['feedUrl'].startswith('https://127.0.0.1:') and 'private-[redacted]' in native['feedUrl']
    inputs = load('inputs/manifest.json')
    assert inputs['candidateHead'] == HEAD and len(inputs['files']) == 16 and len(inputs['optionalFiles']) == 1
    for name in inputs['archiveIncludedInputBytes']:
        entry = next(row for row in inputs['files'] + inputs['optionalFiles'] if row['name'] == name)
        raw = (ROOT / 'inputs' / name).read_bytes()
        assert digest(raw) == entry['fingerprint']['sha256'] and len(raw) == entry['fingerprint']['sizeBytes']
    assert len(list((ROOT / 'gui').glob('*.png'))) == 15
    for name in ('10-xlsx-afterrestart', '11-csv-afterrestart'):
        assert (ROOT / 'gui' / (name + '.png')).read_bytes().startswith(b'\xff\xd8\xff')
        assert 'manifest_' in (ROOT / 'gui' / (name + '.ax.txt')).read_text()
    operator = load('operator-events.json')
    assert operator['userPersonalAcceptance'] == 'not-performed' and not operator['publicReleaseOperation']
    assert 'Ran 10 tests' in (ROOT / 'audit/selftest.txt').read_text()
    print(json.dumps({'status': 'passed-read-only-final-archive-check', 'files': len(manifest['files']), 'sourceHead': HEAD, 'selectedSyntheticProjects': 2, 'outputs': 8, 'guiAndRenderImages': 15, 'csvAttemptsBeforeAfter': [1, 2], 'xlsxAttemptsBeforeAfter': [3, 4], 'userAcceptance': 'not-performed', 'publicReleaseOperation': False}))


if __name__ == '__main__': main()
