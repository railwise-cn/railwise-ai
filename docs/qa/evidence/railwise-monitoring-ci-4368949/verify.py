#!/usr/bin/env python3
"""Read-only integrity and exact-head checks for archived CI metadata."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
HEAD = '43689493ab586c8d65bae729cfd291f3c813f679'


def main():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    assert manifest['sourceHead'] == HEAD
    assert {path.name for path in ROOT.iterdir()} == {'manifest.json', *manifest['files']}
    for name, entry in manifest['files'].items():
        path = ROOT / name
        assert path.is_file() and not path.is_symlink()
        raw = path.read_bytes()
        assert len(raw) == entry['sizeBytes'] and hashlib.sha256(raw).hexdigest() == entry['sha256'], name
    data = json.loads((ROOT / 'ci-runs.json').read_text())
    assert data['sourceHead'] == HEAD and data['repository'] == 'wangjiawei508/WorkWise'
    assert data['packageGuiAcceptance'] == 'not-run-by-this-task' and data['releaseApproval'] is False
    assert {run['databaseId']: run['event'] for run in data['runs']} == {35505927334: 'pull_request', 35505923747: 'push'}
    expected_jobs = {'OpenSpec, brand, lint, type, test, build', 'Electron production smoke', 'Windows path, spawn, persistence'}
    for run in data['runs']:
        assert run['headSha'] == HEAD and run['status'] == 'completed' and run['conclusion'] == 'success'
        assert run['workflowName'] == run['name'] == 'Quality'
        assert run['url'] == f"https://github.com/wangjiawei508/WorkWise/actions/runs/{run['databaseId']}"
        assert not run['rawLogsArchived'] and re.fullmatch('[0-9a-f]{64}', run['retrievedLogSha256'])
        assert len(run['jobs']) == 3 and {job['name'] for job in run['jobs']} == expected_jobs
        for job in run['jobs']:
            assert job['status'] == 'completed' and job['conclusion'] == 'success'
            assert job['checkoutSha'] == (HEAD if run['event'] == 'push' else '477248e6960a4d64c16e9e4d930953651f3955f1')
            assert job['steps'] and all(step['status'] == 'completed' and step['conclusion'] == 'success' for step in job['steps'])
        assert len(run['logSummary']) == 12
        summary = {(line['step'], re.sub(r'\s+', ' ', line['summary']).strip()) for line in run['logSummary']}
        for step, value in [('Run npm test', 'Tests 2814 passed | 6 skipped (2820)'),
                            ('Run npm --prefix kun test', 'Tests 2853 passed | 22 skipped (2875)'),
                            ('Run core Windows security tests', 'Tests 128 passed (128)'),
                            ('Run plugin Windows security tests', 'Tests 104 passed (104)'),
                            ('Run npm run openspec:validate', 'Totals: 11 passed, 0 failed (11 items)')]:
            assert (step, value) in summary
        assert any(line['summary'].split() == 'Tests 60 passed | 2 skipped (62)'.split() for line in run['logSummary'])
    text = (ROOT / 'ci-runs.json').read_text()
    assert not re.search(r'(?i)authorization|bearer\s|api[_-]?key|\x2fUsers\x2f|\x2fhome\x2frunner\x2f|password', text)
    ui = json.loads((ROOT / 'ui-static-summary.json').read_text())
    assert ui['head'] == HEAD and ui['sourceSetSha256'] == '6eb1d244ba4af0031e1416cc756e06ff8851015aea9cec95833a128c06f2f9f3'
    assert ui['rawInventoryArchived'] is False and ui['priorStaticDocumentModified'] is False
    assert ui['summary'] == {'componentFiles': 21, 'helperFiles': 14, 'literalCallSites': 1233, 'dynamicCallSites': 134, 'catalogStringCandidateSites': 441, 'selectedUniqueKeys': 1338, 'selectedMissingEn': 0, 'selectedMissingZh': 0, 'selectedEnglishHanKeys': [], 'untranslatedJsxCandidateSites': 171}
    print(json.dumps({'status': 'passed-read-only-ci-archive-check', 'sourceHead': HEAD, 'successfulRuns': 2, 'successfulJobs': 6, 'candidateGuiVerified': False}))


if __name__ == '__main__':
    main()
