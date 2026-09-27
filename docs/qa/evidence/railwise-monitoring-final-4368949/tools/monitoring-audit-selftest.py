#!/usr/bin/env python3
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('monitoring-audit.py'))
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)
ROOT = Path(__file__).resolve().parent.parent / 'inputs'


class IndependentChecks(unittest.TestCase):
    def setUp(self):
        self.csv = audit.source_rows(ROOT / 'synthetic-monitoring-two-points-irregular.csv')
        self.xlsx = audit.source_rows(ROOT / 'synthetic-monitoring-zero-blank.xlsx')

    def test_independent_source_arithmetic_and_zero_blank(self):
        self.assertEqual(audit.independent(self.csv), audit.independent(self.xlsx))
        self.assertEqual(audit.independent(self.csv)[0]['cumulativeChange'], 8)
        self.assertEqual(audit.independent(self.csv)[1]['changeRate'], -2)
        self.assertTrue(all(row['cumulative'] is None and row['rate'] is None for row in self.xlsx[:3]))
        self.assertEqual((self.xlsx[3]['cumulative'], self.xlsx[3]['rate']), (0, 0))

    def test_old_zero_cumulative_failure_is_rejected(self):
        expected = audit.independent(self.csv)
        wrong = copy.deepcopy(expected); wrong[0]['cumulativeChange'] = 0; wrong[0]['trend'] = 'stable'
        with self.assertRaises(AssertionError): audit.compare_analysis(expected, wrong)

    def test_wrong_irregular_interval_rate_is_rejected(self):
        expected = audit.independent(self.csv)
        wrong = copy.deepcopy(expected); wrong[0]['changeRate'] = 6
        with self.assertRaises(AssertionError): audit.compare_analysis(expected, wrong)

    def test_utc_basis_and_offset_order_are_independent_of_host_timezone(self):
        self.assertEqual(audit.time('2026-08-01T00:00:00'), audit.time('2026-08-01T00:00:00Z'))
        rows = copy.deepcopy(self.csv[:2])
        rows[0].update(timestamp='2026-08-01T23:00:00-08:00', value=7)
        rows[1].update(timestamp='2026-08-02T01:00:00+08:00', value=2)
        result = audit.independent(rows)[0]
        self.assertEqual((result['currentValue'], result['previousValue'], result['cumulativeChange']), (7, 2, 5))
        self.assertAlmostEqual(result['changeRate'], 60 / 7)

    def chart(self, middle=25):
        body = []
        for i, point in enumerate(('S01', 'S02')):
            samples = [row for row in self.csv if row['point'] == point]
            positions = list(zip((0, middle, 100), (100, 80, 20) if i == 0 else (20, 50, 110)))
            circles = ''.join(f'<circle data-role="observation" cx="{x}" cy="{y}"><title>{point} · {row["timestamp"]} · {row["value"]} mm</title></circle>' for row, (x, y) in zip(samples, positions))
            coordinates = ' '.join(f'{x},{y}' for x, y in positions)
            body.append(f'<g data-series-index="{i}"><title>沉降 / {point} (mm)</title>{circles}<polyline data-role="trend-line" points="{coordinates}"/></g>')
        return ('<svg xmlns="http://www.w3.org/2000/svg">' + ''.join(body) + '</svg>').encode()

    def test_actual_time_geometry_passes(self):
        self.assertEqual(audit.chart_check(self.chart(), self.csv)['observations'], 6)

    def test_even_spacing_despite_irregular_time_is_rejected(self):
        with self.assertRaises(AssertionError): audit.chart_check(self.chart(50), self.csv)
        distorted = self.chart().replace(b'cy="80"', b'cy="70"').replace(b'25,80', b'25,70')
        with self.assertRaises(AssertionError): audit.chart_check(distorted, self.csv)
        with self.assertRaises(AssertionError): audit.chart_check(self.chart().replace(b'S02', b'S01'), self.csv)

    def test_report_requires_localized_task_unit_source_and_draft_boundary(self):
        project = {'name': '合成监测', 'taskType': 'deformation', 'monitoringType': 'deformation', 'unit': 'mm', 'signConvention': 'positive'}
        dataset = {'sourceFileName': 'synthetic.csv', 'sourceFileHash': 'a' * 64}
        analysis = {'inputHash': 'b' * 64, 'algorithmVersion': 'workwise-engineering-2'}
        text = '\n'.join(['项目：合成监测', '监测分析报告（待审查）', '任务类型：变形监测', '单位：mm；符号约定：正值为正向变形',
                          '数据来源：synthetic.csv', '源文件 SHA-256：' + 'a' * 64, '分析输入 SHA-256：' + 'b' * 64,
                          '算法版本：workwise-engineering-2', '当前为待审查草稿，不代表专业复核、批准或签名。'])
        audit.report_metadata_check(text, project, dataset, analysis)
        for phrase in ('任务类型：变形监测', '单位：mm', '当前为待审查草稿，不代表专业复核、批准或签名。', 'a' * 64):
            with self.assertRaises(AssertionError): audit.report_metadata_check(text.replace(phrase, 'wrong'), project, dataset, analysis)

    def test_chart_requires_durable_current_renderer_analysis_and_original_bytes(self):
        raw = self.chart(); analysis = {'id': 'analysis-one', 'inputHash': 'input-one'}
        chart = {'id': 'chart-one', 'rendererVersion': 'engineering-trend-2', 'chartType': 'trend', 'validation': 'valid',
                 'analysisId': 'analysis-one', 'inputHash': 'input-one', 'relativePath': 'chart/trend.svg', 'sha256': audit.sha(raw)}
        output = {'path': chart['relativePath'], 'sha256': chart['sha256'], 'mediaType': 'image/svg+xml', 'sizeBytes': len(raw)}
        audit.chart_binding_check(chart, dict(chart), analysis, output, raw)
        for key in ('rendererVersion', 'analysisId', 'inputHash', 'relativePath'):
            wrong = {**chart, key: 'wrong'}
            with self.assertRaises(AssertionError): audit.chart_binding_check(wrong, dict(wrong), analysis, output, raw)
        with self.assertRaises(AssertionError): audit.chart_binding_check(chart, {**chart, 'id': 'other'}, analysis, output, raw)

    def test_typed_hash_and_attempt_snapshot_reject_changed_records(self):
        value = {'a': 0, '中': [None, True, '😀']}
        self.assertEqual(audit.typed_hash(value), audit.sha('o2:{s1:ad0000000000000000s3:中a3:[nts4:😀]}'.encode()))
        records = [('engineering_projects', {'id': 'p', 'unit': 'mm'})]
        binding = {'algorithm': 'typed-json-sha256-v1', 'complete': True, 'engineeringRows': [{'table': 'engineering_projects', 'id': 'p', 'hash': audit.typed_hash(records[0][1])}], 'surveyNetworks': [], 'surveyResults': [], 'surveyDeformations': []}
        audit.attempt_bindings_check(binding, records)
        with self.assertRaises(AssertionError): audit.attempt_bindings_check(binding, [('engineering_projects', {'id': 'p', 'unit': 'm'})])

    def test_restart_cannot_drop_or_rewrite_prior_attempts(self):
        before = [{'id': 'attempt-1', 'outcome': 'failed', 'recordHash': 'old'}]
        audit.preserved_attempts(before, before + [{'id': 'attempt-2', 'outcome': 'passed', 'recordHash': 'new'}])
        with self.assertRaises(AssertionError): audit.preserved_attempts(before, [])
        with self.assertRaises(AssertionError): audit.preserved_attempts(before, [{'id': 'attempt-1', 'outcome': 'passed', 'recordHash': 'new'}])


if __name__ == '__main__': unittest.main()
