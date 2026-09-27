#!/usr/bin/env python3
"""Read-only verification of this synthetic source-evidence archive."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    assert path.is_file() and not path.is_symlink()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    manifest = json.loads((ROOT / 'archive-manifest.json').read_text())
    assert manifest['status'] == 'source-evidence-only-package-acceptance-not-run'
    assert manifest['sourceHead'] == '43689493ab586c8d65bae729cfd291f3c813f679'
    expected = {entry['path']: entry for entry in manifest['files']}
    actual = {str(path.relative_to(ROOT)) for path in ROOT.rglob('*') if path.is_file()}
    assert actual == set(expected) | {'archive-manifest.json'}, 'archive file set changed'
    assert not any(path.is_symlink() for path in ROOT.rglob('*'))
    for name, entry in expected.items():
        path = ROOT / name
        assert path.resolve().is_relative_to(ROOT)
        assert path.stat().st_size == entry['sizeBytes'] and digest(path) == entry['sha256'], name
        if path.suffix in ('.py', '.mjs', '.md', '.json', '.txt', '.csv', '.svg'):
            text = path.read_text()
            assert not re.search(r'\x2fUsers\x2f[^/]+/|\x2fvar\x2ffolders\x2f[^/]+/[^/]+/T/', text), name
            assert not re.search(r'(?i)(?:bearer\s+[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)', text), name
    fixtures = json.loads((ROOT / 'synthetic-input-manifest.json').read_text())
    assert len(fixtures['files']) == 16 and fixtures['copiedCount'] == 14 and fixtures['generatedCount'] == 2
    assert fixtures['databaseCopies'] == fixtures['realP0InputCopies'] == 0
    included = {entry['name']: entry for entry in fixtures['files'] if entry['fixtureClass'] == 'new-synthetic-monitoring-input'}
    for name, entry in included.items():
        assert digest(ROOT / 'inputs' / name) == entry['fingerprint']['sha256']
    optional = fixtures['optionalOffset']
    assert digest(ROOT / 'inputs' / optional['name']) == optional['sha256']
    chart = json.loads((ROOT / 'chart-review/review-manifest.json').read_text())
    for name, sha256 in chart['artifacts'].items():
        assert digest(ROOT / 'chart-review' / name) == sha256
    for record in json.loads((ROOT / 'source-copy-provenance.json').read_text()):
        assert digest(ROOT / record['path']) == record['archiveSha256']
    for name, phrase in {
        'final-desktop-tests.txt': '4 failed | 2814 passed | 2 skipped',
        'final-runtime-tests.txt': '4 failed | 2840 passed | 22 skipped',
        'desktop-serial-suite.txt': '2818 passed | 2 skipped',
        'runtime-frozen-suite.txt': '2853 passed | 22 skipped',
        'frozen-workspace-tests.txt': 'No test files found',
        'frozen-workspace-tests-corrected.txt': '38 passed (38)',
        'audit-selftest.txt': 'Ran 6 tests'
    }.items():
        assert phrase in (ROOT / 'logs' / name).read_text(), name
    matrix = (ROOT / 'FUTURE_PACKAGE_MATRIX.md').read_text()
    rows = [line for line in matrix.splitlines() if re.match(r'\| M\d\d \|', line)]
    assert len(rows) == 8 and all(line.endswith('| not-run |') for line in rows)
    print(json.dumps({'status': 'passed-archive-integrity-only', 'files': len(expected), 'defaultSyntheticFingerprints': 16, 'includedSyntheticInputs': 3, 'futurePackageRowsNotRun': 8, 'packageAcceptance': 'not-run'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
