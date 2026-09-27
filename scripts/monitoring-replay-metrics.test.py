"""Synthetic closed-copy tests; no application/user database is opened."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('monitoring-replay-metrics.py')
spec = importlib.util.spec_from_file_location('replay_metrics', SCRIPT)
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)
START = '2026-09-20T00:00:00Z'
END = '2026-09-21T00:00:00Z'
MID = '2026-09-20T12:00:00Z'
HASH = 'a' * 64
SCHEMA = '''CREATE TABLE engineering_monitoring_replay_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('started', 'finished')), project_id TEXT NOT NULL,
 manifest_id TEXT NOT NULL, occurred_at TEXT NOT NULL, record_hash TEXT NOT NULL,
 data_json TEXT NOT NULL, UNIQUE(attempt_id, phase));'''


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


def result_for(attempt, status='passed', reason='matched', checked=MID):
    result = {
        'schemaVersion': 1, 'attemptId': attempt['id'], 'projectId': 'p', 'manifestId': 'm',
        'checkedAt': checked, 'status': status, 'reasonCode': reason,
        'comparisonVersion': 'monitoring-results-exact-1',
        'execution': {'runtimeVersion': '0.5.0', 'node': '24.18.0', 'v8': '14', 'icu': '77',
                      'platform': 'darwin', 'arch': 'arm64', 'timezone': 'UTC', 'locale': 'zh-CN', 'timeBasis': 'ISO-unzoned-UTC'},
        'analyses': [],
    }
    if status != 'not-applicable':
        result['analyses'] = [{'analysisId': 'a', 'datasetId': 'd', 'algorithmVersion': 'workwise-engineering-2',
                              'inputHash': HASH, 'storedResultsHash': HASH, 'status': status, 'reasonCode': reason}]
    if status == 'passed':
        result['analyses'][0].update(recomputedResultsHash=HASH, sourceFileHash=HASH, sourceContextHash=HASH)
    if reason == 'result-mismatch':
        result['analyses'][0]['recomputedResultsHash'] = 'b' * 64
    return result


class MetricsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-monitoring-replay-')
        self.dbpath = Path(self.temp.name) / 'copy.sqlite3'
        with sqlite3.connect(self.dbpath) as db:
            db.executescript(SCHEMA)

    def tearDown(self):
        self.temp.cleanup()

    def insert(self, event, occurred=None, sql_overrides=None, raw=None):
        raw = encoded(event) if raw is None else raw
        row = {'attempt_id': event['id'], 'phase': event['phase'], 'project_id': event['projectId'],
               'manifest_id': event['manifestId'], 'occurred_at': occurred or event['startedAt'],
               'record_hash': hashed(raw), 'data_json': raw}
        row.update(sql_overrides or {})
        with sqlite3.connect(self.dbpath) as db:
            db.execute('INSERT INTO engineering_monitoring_replay_events(attempt_id,phase,project_id,manifest_id,occurred_at,record_hash,data_json) VALUES(:attempt_id,:phase,:project_id,:manifest_id,:occurred_at,:record_hash,:data_json)', row)
        return row['record_hash']

    def attempt(self, identity, status='passed', reason='matched', start=START, end=MID, mutate=None):
        event = {'schemaVersion': 1, 'id': identity, 'projectId': 'p', 'manifestId': 'm', 'startedAt': start, 'phase': 'started'}
        first = self.insert(event)
        if status == 'incomplete':
            return
        result = result_for(event, status, reason, end)
        if mutate:
            mutate(result)
        finish = {**event, 'phase': 'finished', 'previousHash': first, 'resultHash': hashed(encoded(result)), 'result': result}
        self.insert(finish, end)

    def measure(self):
        return metrics.measure(self.dbpath, START, END)

    def unavailable(self):
        result = self.measure()
        self.assertEqual(result['status'], 'unavailable')
        for key in ('denominator', 'counts', 'recordedPassRate'):
            self.assertIsNone(result[key])

    def test_mixed_statuses_preserve_all_starts_in_denominator(self):
        for identity, status, reason in [('a', 'passed', 'matched'), ('b', 'failed', 'result-mismatch'),
                                        ('c', 'not-evaluated', 'unsupported-algorithm'), ('d', 'not-applicable', 'no-monitoring-analysis'),
                                        ('e', 'incomplete', None)]:
            self.attempt(identity, status, reason)
        result = self.measure()
        self.assertEqual(result['denominator'], 5)
        self.assertEqual(result['counts'], dict.fromkeys(metrics.STATUSES, 1))
        self.assertEqual(result['recordedPassRate'], .2)
        self.assertFalse(result['productionKpi'])

    def test_utc_start_cohort_and_half_open_finish(self):
        self.attempt('start-included', start='2026-09-20T08:00:00+08:00')
        self.attempt('old-start-excluded', start='2026-09-19T23:59:59Z')
        self.attempt('end-excluded', start=END, end=END)
        self.attempt('terminal-at-end', end=END)
        self.attempt('terminal-after-end', end='2026-09-21T01:00:00Z')
        result = self.measure()
        self.assertEqual(result['denominator'], 3)
        self.assertEqual(result['counts']['passed'], 1)
        self.assertEqual(result['counts']['incomplete'], 2)

    def test_no_samples_null_rate_not_zero_or_one(self):
        result = self.measure()
        self.assertEqual(result['status'], 'no-samples')
        self.assertEqual(result['denominator'], 0)
        self.assertIsNone(result['recordedPassRate'])

    def test_missing_legacy_table_not_measurable(self):
        with sqlite3.connect(self.dbpath) as db:
            db.execute('DROP TABLE engineering_monitoring_replay_events')
            db.execute('CREATE TABLE engineering_verification_events(data_json TEXT)')
            db.execute("INSERT INTO engineering_verification_events VALUES ('legacy passed')")
        result = self.measure()
        self.assertEqual(result['status'], 'not-measurable')
        self.assertIsNone(result['denominator'])

    def test_bad_record_hash_even_outside_period_unavailable(self):
        self.attempt('valid')
        self.attempt('outside', start=END, end=END)
        with sqlite3.connect(self.dbpath) as db:
            db.execute("UPDATE engineering_monitoring_replay_events SET record_hash=? WHERE attempt_id='outside'", ('0' * 64,))
        self.unavailable()

    def test_sql_json_identity_mismatch(self):
        self.attempt('valid')
        with sqlite3.connect(self.dbpath) as db:
            db.execute("UPDATE engineering_monitoring_replay_events SET project_id='different'")
        self.unavailable()

    def test_duplicate_json_key_with_rehashed_record(self):
        event = {'schemaVersion': 1, 'id': 'a', 'projectId': 'p', 'manifestId': 'm', 'startedAt': START, 'phase': 'started'}
        self.insert(event, raw=encoded(event).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))
        self.unavailable()

    def test_finish_without_start_is_not_incomplete(self):
        self.attempt('valid')
        with sqlite3.connect(self.dbpath) as db:
            db.execute("DELETE FROM engineering_monitoring_replay_events WHERE phase='started'")
        self.unavailable()

    def test_finish_sequence_before_start(self):
        self.attempt('valid')
        with sqlite3.connect(self.dbpath) as db:
            db.execute("UPDATE engineering_monitoring_replay_events SET sequence=10 WHERE phase='started'")
        self.unavailable()

    def test_duplicate_start_and_finish_rejected_even_without_unique_index(self):
        for phase in ('started', 'finished'):
            with self.subTest(phase=phase):
                with sqlite3.connect(self.dbpath) as db:
                    db.execute('DROP TABLE engineering_monitoring_replay_events')
                    db.executescript(SCHEMA.replace(', UNIQUE(attempt_id, phase)', ''))
                self.attempt('a')
                with sqlite3.connect(self.dbpath) as db:
                    db.execute('INSERT INTO engineering_monitoring_replay_events(attempt_id,phase,project_id,manifest_id,occurred_at,record_hash,data_json) SELECT attempt_id,phase,project_id,manifest_id,occurred_at,record_hash,data_json FROM engineering_monitoring_replay_events WHERE phase=?', (phase,))
                self.unavailable()

    def test_result_time_must_match_sql_and_start_envelope(self):
        self.attempt('a')
        with sqlite3.connect(self.dbpath) as db:
            db.execute("UPDATE engineering_monitoring_replay_events SET occurred_at='2026-09-20T13:00:00Z' WHERE phase='finished'")
        self.unavailable()

    def test_wrong_previous_hash_and_result_hash(self):
        for field in ('previousHash', 'resultHash'):
            with self.subTest(field=field):
                with sqlite3.connect(self.dbpath) as db:
                    db.execute('DELETE FROM engineering_monitoring_replay_events')
                self.attempt('a')
                with sqlite3.connect(self.dbpath) as db:
                    value = json.loads(db.execute("SELECT data_json FROM engineering_monitoring_replay_events WHERE phase='finished'").fetchone()[0])
                    value[field] = 'b' * 64
                    raw = encoded(value)
                    db.execute("UPDATE engineering_monitoring_replay_events SET data_json=?,record_hash=? WHERE phase='finished'", (raw, hashed(raw)))
                self.unavailable()

    def test_clock_regression(self):
        self.attempt('a', end='2026-09-19T23:59:59Z')
        self.unavailable()

    def test_result_contract_tampering_even_with_valid_hashes(self):
        mutations = [lambda r: r.update(attemptId='other'), lambda r: r.update(projectId='other'),
                     lambda r: r.update(schemaVersion=True), lambda r: r.update(extra='unknown'),
                     lambda r: r.update(status=None, reasonCode='unknown'),
                     lambda r: r.update(status='not-evaluated'), lambda r: r.update(analyses=[]),
                     lambda r: r['analyses'][0].pop('sourceFileHash'),
                     lambda r: r['analyses'][0].update(recomputedResultsHash='b' * 64),
                     lambda r: r['execution'].update(extra='unknown'),
                     lambda r: r['analyses'][0].update(inputHash='bad'),
                     lambda r: r.update(detail='\U0001f600' * 121)]
        for index, mutation in enumerate(mutations):
            with self.subTest(mutation=index):
                with sqlite3.connect(self.dbpath) as db:
                    db.execute('DELETE FROM engineering_monitoring_replay_events')
                self.attempt('a', mutate=mutation)
                self.unavailable()

    def test_not_evaluated_and_na_never_count_as_pass(self):
        self.attempt('a', 'not-evaluated', 'source-unavailable')
        self.attempt('b', 'not-applicable', 'no-monitoring-analysis')
        result = self.measure()
        self.assertEqual(result['denominator'], 2)
        self.assertEqual(result['recordedPassRate'], 0)

    def test_node_json_stringify_hash_compatibility(self):
        self.attempt('a', mutate=lambda r: r.update(detail='中文\n\t\u2028 / " \\'))
        with sqlite3.connect(self.dbpath) as db:
            raw = db.execute("SELECT data_json FROM engineering_monitoring_replay_events WHERE phase='finished'").fetchone()[0]
            generated = subprocess.check_output(['node', '-e', "const fs=require('node:fs'),crypto=require('node:crypto'); const e=JSON.parse(fs.readFileSync(0,'utf8')); e.resultHash=crypto.createHash('sha256').update(JSON.stringify(e.result)).digest('hex'); process.stdout.write(JSON.stringify(e));"], input=raw.encode()).decode()
            db.execute("UPDATE engineering_monitoring_replay_events SET data_json=?,record_hash=? WHERE phase='finished'", (generated, hashed(generated)))
        self.assertEqual(self.measure()['counts']['passed'], 1)

    def test_old_verification_tables_unaffected_and_read_only(self):
        self.attempt('a')
        with sqlite3.connect(self.dbpath) as db:
            db.execute('CREATE TABLE engineering_verification_events(data_json TEXT)')
            db.execute("INSERT INTO engineering_verification_events VALUES ('deliberately unrelated legacy content')")
        before = self.dbpath.read_bytes()
        result = self.measure()
        self.assertEqual(result['counts']['passed'], 1)
        self.assertEqual(self.dbpath.read_bytes(), before)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [self.dbpath])
        serialized = json.dumps(result)
        self.assertNotIn(str(self.dbpath), serialized)
        self.assertNotIn('attemptId', serialized)

    def test_unclosed_sidecar_is_unavailable(self):
        Path(str(self.dbpath) + '-wal').touch()
        self.unavailable()

    def test_legacy_metrics_identical_before_and_after_new_table(self):
        old_spec = importlib.util.spec_from_file_location('legacy_metric_fixture', SCRIPT.with_name('test_measure_survey_workflows.py'))
        old_tests = importlib.util.module_from_spec(old_spec)
        old_spec.loader.exec_module(old_tests)
        fixture = old_tests.MetricsTests()
        fixture.setUp()
        try:
            fixture.draft()
            before = fixture.measure()
            fixture.eng.executescript(SCHEMA)
            fixture.eng.execute("INSERT INTO engineering_monitoring_replay_events(attempt_id,phase,project_id,manifest_id,occurred_at,record_hash,data_json) VALUES('new','started','p','m',?,?,'intentionally invalid for new metrics')", (START, HASH))
            self.assertEqual(fixture.measure(), before)
        finally:
            fixture.tearDown()

    def test_wrong_schema_and_corrupt_database(self):
        with sqlite3.connect(self.dbpath) as db:
            db.execute('ALTER TABLE engineering_monitoring_replay_events ADD COLUMN extra TEXT')
        self.unavailable()
        self.dbpath.write_bytes(b'not SQLite')
        self.unavailable()

    def test_period_requires_timezone_calendar_and_order(self):
        for start, end in [('2026-09-20T00:00:00', END), ('2026-02-30T00:00:00Z', END),
                           ('2026-09-20T00:00:00+01:99', END), (END, START), (START, START)]:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                metrics.measure(self.dbpath, start, end)

    def test_cli_emits_null_on_corruption_and_nonzero_exit(self):
        self.dbpath.write_bytes(b'corrupt')
        process = subprocess.run([sys.executable, str(SCRIPT), '--database-copy', str(self.dbpath), '--start', START, '--end', END], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(process.stdout)['status'], 'unavailable')
        self.assertIsNone(json.loads(process.stdout)['counts'])


if __name__ == '__main__':
    unittest.main()
