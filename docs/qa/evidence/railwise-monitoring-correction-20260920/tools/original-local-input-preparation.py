#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from xml.sax.saxutils import escape

DEST = Path('/private/tmp/railwise-survey-27738f4/inputs')
MANIFEST = Path('/private/tmp/railwise-277-monitoring-inputs.json')
SOURCE_MANIFEST = Path('/private/tmp/railwise-53213-synthetic-ui-copy-manifest.json')
HEADER = ['监测项', '测点', '时间', '数值', '单位']
ROWS = [
    ['沉降', 'S01', '2026-08-01T00:00:00Z', '0', 'mm'],
    ['沉降', 'S01', '2026-08-02T00:00:00Z', '2', 'mm'],
    ['沉降', 'S01', '2026-08-05T00:00:00Z', '8', 'mm'],
    ['沉降', 'S02', '2026-08-01T00:00:00Z', '8', 'mm'],
    ['沉降', 'S02', '2026-08-02T00:00:00Z', '5', 'mm'],
    ['沉降', 'S02', '2026-08-05T00:00:00Z', '-1', 'mm'],
]


def fp(path):
    raw = path.read_bytes()
    return {'sizeBytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def main():
    assert not MANIFEST.exists()
    assert not DEST.exists() or not any(DEST.iterdir())
    old = json.loads(SOURCE_MANIFEST.read_text())
    assert len(old['files']) == 14
    for entry in old['files']:
        assert fp(Path(entry['targetPath'])) == entry['target']
    DEST.mkdir(mode=0o700, parents=True, exist_ok=True)
    files = []
    for entry in old['files']:
        source, target = Path(entry['targetPath']), DEST / entry['name']
        with target.open('xb') as handle:
            os.chmod(handle.name, 0o600)
            handle.write(source.read_bytes())
        assert fp(source) == fp(target) == entry['target']
        files.append({'name': entry['name'], 'source': str(source), 'target': str(target), 'fingerprint': fp(target), 'fixtureClass': entry['fixtureClass'], 'copiedByteIdentical': True})
    csv_path = DEST / 'synthetic-monitoring-two-points-irregular.csv'
    with csv_path.open('x') as handle:
        os.chmod(handle.name, 0o600)
        handle.write('\n'.join(','.join(row) for row in [HEADER, *ROWS]) + '\n')
    workbook_rows = [HEADER + ['累计变化', '速率']]
    # S01 optional numbers are blank, including whitespace; S02 explicitly begins at zero.
    for index, row in enumerate(ROWS):
        optional = [('', ' '), (' ', ''), ('', ''), ('0', '0'), ('-3', '-3'), ('-9', '-2')][index]
        workbook_rows.append([*row, *optional])
    sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + ''.join(
        '<row r="' + str(i+1) + '">' + ''.join('<c r="' + chr(65+j) + str(i+1) + '" t="inlineStr"><is><t xml:space="preserve">' + escape(value) + '</t></is></c>' for j, value in enumerate(row)) + '</row>'
        for i, row in enumerate(workbook_rows)) + '</sheetData></worksheet>'
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="合成监测" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': sheet,
    }
    xlsx_path = DEST / 'synthetic-monitoring-zero-blank.xlsx'
    with xlsx_path.open('xb') as handle:
        os.chmod(handle.name, 0o600)
        with ZipFile(handle, 'w', compression=ZIP_DEFLATED) as zipped:
            for name, text in parts.items():
                info = ZipInfo(name, date_time=(2026, 8, 1, 0, 0, 0)); info.compress_type = ZIP_DEFLATED
                zipped.writestr(info, text.encode())
    for path in (csv_path, xlsx_path):
        files.append({'name': path.name, 'target': str(path), 'fingerprint': fp(path), 'fixtureClass': 'new-synthetic-monitoring-input', 'generatedBy': str(Path(__file__)), 'generatorSha256': fp(Path(__file__))['sha256']})
    report = {'schemaVersion': 1, 'status': 'prepared-not-executed', 'candidateHead': None, 'candidateRootPlaceholder': str(DEST.parent), 'copiedCount': 14, 'generatedCount': 2, 'databaseCopies': 0, 'realP0InputCopies': 0, 'files': files, 'knownIndependentExpectations': {'intervalDays': [1, 3], 'S01': {'currentValue': 8, 'previousValue': 2, 'cumulativeChange': 8, 'changeRate': 2, 'trend': 'rising'}, 'S02': {'currentValue': -1, 'previousValue': 5, 'cumulativeChange': -9, 'changeRate': -2, 'trend': 'falling'}, 'observations': 6, 'series': 2}, 'limit': 'Synthetic preparation only. Final candidate head/package identity not frozen; no GUI or audit pass claimed.'}
    with MANIFEST.open('x') as handle:
        os.chmod(handle.name, 0o600)
        json.dump(report, handle, ensure_ascii=False, indent=2); handle.write('\n')
    print(json.dumps({'status': report['status'], 'files': len(files), 'manifest': str(MANIFEST)}))


if __name__ == '__main__':
    main()
