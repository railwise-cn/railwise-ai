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


if __name__ == '__main__': unittest.main()
