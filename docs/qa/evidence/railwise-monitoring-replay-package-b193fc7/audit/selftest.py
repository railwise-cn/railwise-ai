#!/usr/bin/env python3
"""Focused tests for the independent package audit helpers; no candidate DB reads."""
import io
import json
import unittest
from zipfile import ZipFile
import audit


class AuditHelpers(unittest.TestCase):
    def project(self):
        return {'id': 'synthetic', 'monitoringType': 'settlement', 'unit': 'mm', 'thresholds': {'default': 10}}

    def test_csv_blank_zero_and_complete_provenance(self):
        raw = b'point,time,value,cumulative,rate\nP1,2026-01-01,0,,0\nP1,2026-01-03,10,0,\n'
        rows = audit.tabular(raw, 'sample.csv', None)
        mapping = {'point': 'point', 'timestamp': 'time', 'value': 'value', 'cumulative': 'cumulative', 'rate': 'rate'}
        obs = audit.normalize(rows, mapping, self.project(), audit.sha(raw), 'dataset')
        self.assertNotIn('cumulative', obs[0]); self.assertEqual(obs[0]['rate'], 0)
        self.assertEqual(obs[1]['cumulative'], 0); self.assertNotIn('rate', obs[1])
        self.assertEqual(obs[0]['sourceFields'], rows[0]); self.assertEqual(obs[1]['sourceRow'], 3)
        self.assertEqual(obs[0]['id'], 'obs_' + audit.sha(raw)[:12] + '_0')

    def test_xlsx_requested_mapping_and_worksheet_provenance(self):
        def sheet(headers, values):
            def row(items, n):
                return '<row>' + ''.join(f'<c r="{chr(65+i)}{n}" t="inlineStr"><is><t>{value}</t></is></c>' for i, value in enumerate(items)) + '</row>'
            return '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + row(headers, 1) + row(values, 2) + '</sheetData></worksheet>'
        stream = io.BytesIO()
        with ZipFile(stream, 'w') as archive:
            archive.writestr('xl/worksheets/sheet1.xml', sheet(['p', 't', 'v'], ['P1', '2026-01-01', '1']))
            archive.writestr('xl/worksheets/sheet2.xml', sheet(['note'], ['metadata']))
            archive.writestr('xl/worksheets/sheet3.xml', sheet(['p', 't', 'v'], ['P2', '2026-01-02', '2']))
        mapping = {'point': 'p', 'timestamp': 't', 'value': 'v'}
        rows = audit.tabular(stream.getvalue(), 'sample.xlsx', mapping)
        self.assertEqual(len(rows), 2)
        self.assertEqual([row['__worksheet'] for row in rows], ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml'])

    def test_full_arithmetic_including_threshold_and_anomaly(self):
        result = audit.arithmetic([{'monitoringItem': 's', 'point': 'P', 'timestamp': '2026-01-01', 'value': 2, 'cumulative': 0}, {'monitoringItem': 's', 'point': 'P', 'timestamp': '2026-01-03', 'value': 10, 'cumulative': 12}], self.project())
        self.assertEqual(result, [{'monitoringItem': 's', 'point': 'P', 'currentValue': 10, 'previousValue': 2, 'cumulativeChange': 12, 'changeRate': 4, 'trend': 'rising', 'anomaly': True, 'thresholdStatus': 'alarm'}])

    def test_workbook_boolean_comparison_preserves_false_and_true(self):
        for value in (False, True):
            expected = [{'monitoringItem': 's', 'point': 'P', 'anomaly': value, 'currentValue': 0}]
            for actual in (value, str(value).lower()):
                audit.legacy.compare_analysis(expected, [{**expected[0], 'anomaly': actual, 'currentValue': '0'}])

    def test_workbook_boolean_comparison_rejects_wrong_or_coerced_values(self):
        for value in (False, True):
            expected = [{'monitoringItem': 's', 'point': 'P', 'anomaly': value}]
            for actual in (not value, str(not value).lower(), 0, 1, '0', '1', '', None, 'FALSE', 'TRUE'):
                with self.subTest(value=value, actual=actual), self.assertRaisesRegex(AssertionError, 'analysis differs'):
                    audit.legacy.compare_analysis(expected, [{**expected[0], 'anomaly': actual}])
        with self.assertRaisesRegex(AssertionError, 'analysis differs'):
            audit.legacy.compare_analysis([{'monitoringItem': 's', 'point': 'P', 'currentValue': 1}], [{'monitoringItem': 's', 'point': 'P', 'currentValue': True}])

    def test_single_observation_omits_undefined(self):
        result = audit.arithmetic([{'monitoringItem': 's', 'point': 'P', 'timestamp': '2026-01-01', 'value': 8}], self.project())[0]
        self.assertEqual(result['trend'], 'unknown'); self.assertEqual(result['thresholdStatus'], 'warning')
        self.assertNotIn('previousValue', result); self.assertNotIn('cumulativeChange', result)

    def test_equivalent_offset_ties_cannot_pass(self):
        with self.assertRaisesRegex(AssertionError, 'tie-order'):
            audit.arithmetic([{'monitoringItem': 's', 'point': 'P', 'timestamp': '2026-01-01T00:00:00Z', 'value': 0}, {'monitoringItem': 's', 'point': 'P', 'timestamp': '2026-01-01T08:00:00+08:00', 'value': 1}], self.project())

    def test_js_serialization_handles_integer_floats_and_canonical_keys(self):
        self.assertEqual(audit.js_hash({'a': 0.0, 'b': 2.0}), audit.sha(b'{"a":0,"b":2}'))
        self.assertEqual(audit.js_hash({'b': 2.0, 'a': 0.0}, True), audit.sha(b'{"a":0,"b":2}'))

    def test_result_validator_rejects_missing_source_pass(self):
        result = {'schemaVersion': 1, 'attemptId': 'a', 'projectId': 'p', 'manifestId': 'm', 'checkedAt': '2026-01-01T00:00:00Z', 'status': 'passed', 'reasonCode': 'matched', 'comparisonVersion': 'monitoring-results-exact-1',
                  'execution': {**dict.fromkeys(['runtimeVersion', 'node', 'v8', 'icu', 'platform', 'arch', 'timezone', 'locale'], 'test'), 'timeBasis': 'ISO-unzoned-UTC'},
                  'analyses': [{'analysisId': 'analysis', 'datasetId': 'dataset', 'algorithmVersion': 'v2', 'inputHash': 'a'*64, 'storedResultsHash': 'b'*64, 'recomputedResultsHash': 'b'*64, 'status': 'passed', 'reasonCode': 'matched'}]}
        event = {'id': 'a', 'projectId': 'p', 'manifestId': 'm'}
        with self.assertRaises(audit.validator.InvalidEvidence):
            audit.validator.validate_result(result, event)
        result['analyses'][0].update(sourceFileHash='c'*64, sourceContextHash='d'*64)
        audit.validator.validate_result(result, event)


if __name__ == '__main__':
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AuditHelpers))
    log = stream.getvalue()
    with (audit.BASE / 'selftest-corrected.log').open('x') as handle:
        handle.write(log)
    print(log, end='')
    raise SystemExit(0 if result.wasSuccessful() else 1)
