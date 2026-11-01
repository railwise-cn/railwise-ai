"""Read an existing final7 GUI export; never creates an export or edits fixtures."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path('/Users/wangjiawei/Documents/WorkWise')
DESTINATION = Path(__file__).resolve().parent
WORKSPACE = ROOT / 'dist/railwise-0.5.4-markdown-workbench-private-final7/home/workspace/markdown-workbench'
EXPORTED = WORKSPACE / 'export-stress-final7.docx'
FIXTURE = WORKSPACE / 'export-stress.md'
PREVIOUS_FIXTURE = DESTINATION.parent / 'packaged-export-final6/export-stress.source.md'
ARCHIVE = ROOT / 'dist/railwise-0.5.4-markdown-workbench-private-final7/Applications/RailWise AI Candidate 5c88bfd6de0a.app/Contents/Resources/app.asar'
ASAR_SHA256 = '487f5c5ff8236e9e92f4d83f4e52c87afd2e06503b72918fcb07856545cccc4a'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fences(source):
    return re.findall(r'^```(\w+)\r?\n([\s\S]*?)\r?\n```\s*$', source, re.MULTILINE)


data = EXPORTED.read_bytes()
fixture_bytes = FIXTURE.read_bytes()
fixture = fixture_bytes.decode('utf-8')
previous = PREVIOUS_FIXTURE.read_bytes()
blocks = fences(fixture)
previous_blocks = fences(previous.decode('utf-8'))
archive_hash = sha256(ARCHIVE.read_bytes())
DESTINATION.mkdir(parents=True, exist_ok=True)
evidence_export = DESTINATION / EXPORTED.name
shutil.copyfile(EXPORTED, evidence_export)
shutil.copyfile(FIXTURE, DESTINATION / 'export-stress.source.md')

with zipfile.ZipFile(evidence_export) as package:
    xml = package.read('word/document.xml')
tree = ET.fromstring(xml)
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
# The XML parser decodes exactly one XML layer. Literal entity strings in code
# remain literal; a second HTML decode would conceal a real export defect.
paragraphs = []
for paragraph in tree.findall('.//w:p', NS):
    text = ''.join(node.text or '' for node in paragraph.findall('.//w:t', NS))
    style = paragraph.find('./w:pPr/w:pStyle', NS)
    paragraphs.append({'style': style.get('{%s}val' % NS['w']) if style is not None else None, 'text': text})
texts = [paragraph['text'] for paragraph in paragraphs]
body = '\n'.join(texts)
expected = {language: code for language, code in blocks}
prior_expected = {language: code for language, code in previous_blocks}
checks = {
    'exactFinal7Asar': archive_hash == ASAR_SHA256,
    'exactEvidenceCopy': sha256(data) == sha256(evidence_export.read_bytes()),
    'onlyUserCardToPanelChange': previous.count(b'class="card"') == 1 and fixture_bytes == previous.replace(b'class="card"', b'class="panel"'),
    'twoExpectedCodeBlocks': [language for language, _ in blocks] == ['ts', 'html'],
    'everyCodeParagraphExact': len(blocks) == 2 and all(texts.count(code) == 1 for _, code in blocks),
    'typeScriptSourceUnchanged': expected.get('ts') == prior_expected.get('ts'),
    'htmlSourceHasPanel': 'class="panel"' in expected.get('html', '') and 'class="card"' not in expected.get('html', ''),
    'frontmatterHidden': 'title: DOCX 字符保真验收' not in body and 'stage: reviewed' not in body,
    'noHighlightMarkupLeak': '<span' not in body and 'hljs-' not in body,
    'literalEntitiesRetained': all(entity in body for entity in ['&#x27;', '&quot;', '&lt;', '&amp;']),
}
report = {
    'schema': 'railwise.markdown-workbench.packaged-docx-readback.v1',
    'inspectedAt': datetime.now(timezone.utc).isoformat(),
    'provenance': {
        'product': 'RailWise AI', 'version': '0.5.4', 'candidate': 'final7',
        'sourceHead': '5c88bfd6de0a65e0436cb33bcc1c6528154e20dd',
        'asarSha256': archive_hash, 'sourcePath': str(EXPORTED),
        'exportOrigin': 'Fresh final7 GUI export by root agent after a rich-mode card→panel edit/save; this independent tool only copies and reads existing files.',
        'xmlDecoding': 'Python standard XML parser, exactly one XML entity layer; no HTML/entity decoder.',
    },
    'file': {'evidencePath': str(evidence_export), 'sizeBytes': len(data), 'sha256': sha256(data)},
    'fixture': {'path': str(FIXTURE), 'sizeBytes': len(fixture_bytes), 'sha256': sha256(fixture_bytes), 'expectedCode': expected},
    'previousFixture': {'path': str(PREVIOUS_FIXTURE), 'sha256': sha256(previous)},
    'paragraphs': paragraphs, 'checks': checks, 'allChecksPassed': all(checks.values()),
}
(DESTINATION / 'readback.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'file': report['file'], 'checks': checks, 'allChecksPassed': report['allChecksPassed']}, ensure_ascii=False, indent=2))
if not report['allChecksPassed']:
    raise SystemExit('Final7 packaged export readback failed; evidence retained.')
