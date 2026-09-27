#!/usr/bin/env python3
"""Read-only, aggregate Survey workflow evidence; never infer professional approval.

Reads two SQLite snapshots through mode=ro. Does not read source files, emit project
names/coordinates/paths, recompute adjustments, or send telemetry. A candidate cohort
is not a production sample. All period comparisons use UTC [start, end).
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import hashlib
import math
import re
from pathlib import Path
import sqlite3
import statistics
import struct
import sys


def instant(value):
    if not isinstance(value, str):
        raise ValueError('timestamp missing')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('timestamp must include timezone')
    return result.astimezone(timezone.utc)


def records(connection, table):
    # table names below are constants, never caller input.
    rows = [json.loads(row[0]) for row in connection.execute('SELECT data_json FROM ' + table)]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError('invalid stored record')
    return rows


def indexed(rows, nested=None):
    result = {}
    for row in rows:
        identity = row.get(nested, {}) if nested else row
        key = identity.get('id')
        if not isinstance(key, str) or not key or key in result:
            raise ValueError('missing or duplicate stored identity')
        result[key] = row
    return result


@contextmanager
def readonly_database(path):
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        yield connection
    finally:
        connection.close()


def unavailable(reason):
    return {'value': None, 'status': 'not-measurable', 'reason': reason}


def recorded_import_metrics(survey, start, end):
    """First observed caller keys, not first production tasks or file validity."""
    names = {row[0] for row in survey.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'survey_import_attempt_events' not in names:
        return unavailable('No durable import attempt ledger; rejected requests cannot be inferred from networks.')
    attempts = {}
    reasons = {'validation', 'preparation', 'replay', 'project', 'parse', 'commit', 'projection',
               'invalid-json', 'body-too-large', 'body-read', 'structured-http'}
    dispositions = {'adjustment-ready', 'legacy-unverified', 'archive-only', 'gnss-processing-required', 'converter-required'}
    try:
        rows = survey.execute('SELECT sequence,attempt_id,phase,occurred_at,record_hash,data_json FROM survey_import_attempt_events ORDER BY sequence')
        previous_sequence = 0
        for sequence, identity, phase, occurred, digest, serialized in rows:
            event = json.loads(serialized)
            common = {'schemaVersion', 'attemptId', 'phase', 'occurredAt', 'previousHash'}
            extra = {'started': {'taskHash', 'mode'}, 'committed': {'replay', 'sourceDisposition'},
                     'finished': {'outcome', 'rejection'}}
            if (sequence <= previous_sequence or not isinstance(identity, str) or not identity
                    or phase not in extra or set(event) != common | extra[phase]
                    or event.get('schemaVersion') != 1
                    or any(event.get(k) != v for k, v in [('attemptId', identity), ('phase', phase), ('occurredAt', occurred)])
                    or hashlib.sha256(serialized.encode('utf-8')).hexdigest() != digest):
                raise ValueError('invalid import audit envelope')
            previous_sequence = sequence
            timestamp = instant(occurred)
            if phase == 'started':
                if (identity in attempts or event['previousHash'] is not None
                        or event['mode'] not in {'file', 'legacy-structured', 'unclassified'}
                        or (event['taskHash'] is not None and (not isinstance(event['taskHash'], str)
                            or not re.fullmatch('[0-9a-f]{64}', event['taskHash'])))):
                    raise ValueError('invalid import start')
                attempts[identity] = {'started': event, 'sequence': sequence, 'time': timestamp, 'hash': digest,
                                      'lastTime': timestamp, 'committed': None, 'finished': None}
            else:
                attempt = attempts.get(identity)
                if (not attempt or attempt[phase] is not None or attempt['finished'] is not None
                        or event['previousHash'] != attempt['hash'] or timestamp < attempt['lastTime']):
                    raise ValueError('invalid import audit chain')
                if phase == 'committed':
                    if type(event['replay']) is not bool or event['sourceDisposition'] not in dispositions:
                        raise ValueError('invalid import commit')
                elif (event['outcome'] not in {'succeeded', 'rejected'}
                      or (event['outcome'] == 'succeeded' and (event['rejection'] is not None or attempt['committed'] is None))
                      or (event['outcome'] == 'rejected' and event['rejection'] not in reasons)
                      or (event['outcome'] == 'rejected' and attempt['committed'] is not None and event['rejection'] != 'projection')):
                    raise ValueError('invalid import terminal')
                attempt[phase] = event
                attempt['hash'], attempt['lastTime'] = digest, timestamp
        # Only receipts before period end may finish an attempt in this snapshot.
        history = []
        for attempt in attempts.values():
            if attempt['time'] >= end:
                continue
            for phase in ('committed', 'finished'):
                if attempt[phase] and instant(attempt[phase]['occurredAt']) >= end:
                    attempt[phase] = None
            history.append(attempt)
        selected = [a for a in history if a['time'] >= start]
        def succeeded(a):
            return a['finished'] is not None and a['finished']['outcome'] == 'succeeded'
        def rejected(a):
            return a['finished'] is not None and a['finished']['outcome'] == 'rejected'
        first = {}
        for attempt in history:
            key = attempt['started']['taskHash']
            if key is not None:
                first.setdefault(key, attempt)
        first_in_period = [a for a in first.values() if a['time'] >= start]
        observed = [a for a in first_in_period if a['started']['mode'] == 'file'
                    and not (a['committed'] and a['committed']['replay'])]
        return {
            'status': 'measured' if selected else 'no-samples',
            'boundary': 'Service entry/completion plus authenticated HTTP rejections after body reading. Subsequent HTTP response assembly/delivery and UI completion are outside this boundary. Crashes during body reading and unavailable audit storage are not enumerable; no historical backfill.',
            'counts': {
                'startedInPeriod': len(selected), 'succeededByPeriodEnd': sum(map(succeeded, selected)),
                'rejectedByPeriodEnd': sum(map(rejected, selected)),
                'incompleteAtPeriodEnd': sum(a['finished'] is None for a in selected),
                'committedRequests': sum(a['committed'] is not None for a in selected),
                'replayRequests': sum(bool(a['committed'] and a['committed']['replay']) for a in selected),
                'unidentifiableRequestKeys': sum(a['started']['taskHash'] is None for a in selected),
                'nonFileRequests': sum(a['started']['mode'] != 'file' for a in selected),
                'firstObservedKeysInPeriod': len(first_in_period),
                'firstKeysExcludedAsReplayOrNonFile': len(first_in_period) - len(observed),
                'firstObservedFileKeysIncomplete': sum(a['finished'] is None for a in observed)},
            'firstObservedFileRequestCompletionRate': {
                'value': sum(map(succeeded, observed)) / len(observed) if observed else None,
                'status': 'measured' if observed else 'no-samples',
                'numerator': sum(map(succeeded, observed)), 'denominator': len(observed),
                'definition': 'Earliest recorded invocation per caller-declared project/idempotency key; file-mode subset only, excluding first observed replays. Incomplete first invocations stay in denominator; later retries never replace them. Service completion does not establish HTTP/UI completion, source eligibility, adjustment validity, production provenance or first-ever task success.'},
            'successfulRequestSourceDispositions': {
                disposition: sum(succeeded(a) and a['committed']['sourceDisposition'] == disposition for a in selected)
                for disposition in sorted(dispositions)},
            'rejectionStages': {reason: sum(rejected(a) and a['finished']['rejection'] == reason for a in selected)
                                for reason in sorted(reasons)}}
    except (ValueError, TypeError, KeyError, AttributeError, sqlite3.Error):
        return unavailable('Import attempt ledger failed identity, digest, sequence, timestamp or lifecycle validation.')


def snapshot_hash(value):
    """typed-json-sha256-v1, shared with EngineeringService's audit writer."""
    digest = hashlib.sha256()
    def put(text):
        digest.update(text.encode('utf-8'))
    def visit(item):
        if item is None:
            put('n')
        elif isinstance(item, bool):
            put('t' if item else 'f')
        elif isinstance(item, (int, float)):
            number = float(item)
            if not math.isfinite(number):
                raise ValueError('non-finite verification snapshot')
            put('d' + struct.pack('>d', 0.0 if number == 0 else number).hex())
        elif isinstance(item, str):
            encoded = item.encode('utf-8')
            put('s' + str(len(encoded)) + ':'); digest.update(encoded)
        elif isinstance(item, list):
            put('a' + str(len(item)) + ':[')
            for child in item:
                visit(child)
            put(']')
        elif isinstance(item, dict):
            keys = sorted(item, key=lambda key: key.encode('utf-8'))
            put('o' + str(len(keys)) + ':{')
            for key in keys:
                visit(key); visit(item[key])
            put('}')
        else:
            raise ValueError('unsupported verification snapshot value')
    visit(value)
    return digest.hexdigest()


def recorded_verification_lifecycle(engineering, start, end):
    """Started cohort, including interrupted attempts; never current validity."""
    names = {row[0] for row in engineering.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {'engineering_verification_events', 'engineering_verification_attempts'} <= names:
        return unavailable('No durable verification lifecycle; historical terminal records cannot supply starts.')
    try:
        terminals = {}
        for sequence, identity, pid, mid, began, ended, outcome, digest, serialized in engineering.execute(
                'SELECT sequence,id,project_id,manifest_id,started_at,completed_at,outcome,record_hash,data_json FROM engineering_verification_attempts ORDER BY sequence'):
            event = json.loads(serialized)
            if (not isinstance(identity, str) or not identity or identity in terminals
                    or type(event.get('schemaVersion')) is not int or event['schemaVersion'] != 1
                    or hashlib.sha256(serialized.encode('utf-8')).hexdigest() != digest
                    or any(event.get(key) != value for key, value in [('id', identity), ('projectId', pid), ('manifestId', mid), ('startedAt', began), ('completedAt', ended), ('outcome', outcome)])
                    or outcome not in ('passed', 'failed', 'error') or instant(began) > instant(ended)):
                raise ValueError('invalid terminal binding')
            terminals[identity] = {'event': event, 'hash': digest, 'completed': instant(ended)}
        attempts = {}
        previous_sequence = 0
        for sequence, identity, phase, occurred, digest, serialized in engineering.execute(
                'SELECT sequence,attempt_id,phase,occurred_at,record_hash,data_json FROM engineering_verification_events ORDER BY sequence'):
            event = json.loads(serialized)
            common = {'schemaVersion', 'attemptId', 'phase', 'occurredAt', 'previousHash'}
            extra = {'started': {'projectId', 'manifestId'}, 'finished': {'terminalId', 'terminalRecordHash', 'outcome'}}
            if (type(sequence) is not int or sequence <= previous_sequence or not isinstance(identity, str) or not identity
                    or phase not in extra or set(event) != common | extra[phase]
                    or type(event.get('schemaVersion')) is not int or event['schemaVersion'] != 1
                    or hashlib.sha256(serialized.encode('utf-8')).hexdigest() != digest
                    or any(event.get(key) != value for key, value in [('attemptId', identity), ('phase', phase), ('occurredAt', occurred)])):
                raise ValueError('invalid lifecycle envelope')
            previous_sequence = sequence
            time = instant(occurred)
            if phase == 'started':
                if (identity in attempts or event['previousHash'] is not None
                        or not all(isinstance(event[key], str) for key in ('projectId', 'manifestId'))):
                    raise ValueError('invalid lifecycle start')
                attempts[identity] = {'event': event, 'time': time, 'hash': digest, 'finished': None}
            else:
                attempt = attempts.get(identity)
                terminal = terminals.get(identity)
                if (not attempt or attempt['finished'] is not None or not terminal
                        or event['previousHash'] != attempt['hash'] or time < attempt['time']
                        or event['terminalId'] != identity or event['terminalRecordHash'] != terminal['hash']
                        or event['outcome'] != terminal['event']['outcome']
                        or terminal['event']['startedAt'] != attempt['event']['occurredAt']
                        or terminal['event']['completedAt'] != occurred
                        or any(terminal['event'][key] != attempt['event'][key] for key in ('projectId', 'manifestId'))):
                    raise ValueError('invalid lifecycle finish')
                attempt['finished'] = {'time': time, 'outcome': event['outcome']}
        # New terminal records and finish receipts are one atomic write. An
        # orphan is corruption, not a legitimate interrupted attempt.
        if any(identity in terminals and attempt['finished'] is None for identity, attempt in attempts.items()):
            raise ValueError('terminal without atomic finish')
        selected = [attempt for attempt in attempts.values() if start <= attempt['time'] < end]
        finished = [attempt['finished'] for attempt in selected if attempt['finished'] is not None and attempt['finished']['time'] < end]
        outcomes = {key: sum(item['outcome'] == key for item in finished) for key in ('passed', 'failed', 'error')}
        return {
            'status': 'measured' if selected else 'no-samples',
            'counts': {'startedInPeriod': len(selected), 'finishedByPeriodEnd': len(finished),
                       'incompleteAtPeriodEnd': len(selected) - len(finished),
                       'legacyTerminalOnlyCompletedInPeriod': sum(identity not in attempts and start <= terminal['completed'] < end for identity, terminal in terminals.items())},
            'outcomesByPeriodEnd': outcomes,
            'recordedTerminalPassRate': {
                'value': outcomes['passed'] / len(selected) if selected else None,
                'status': 'measured' if selected else 'no-samples',
                'numerator': outcomes['passed'], 'denominator': len(selected)},
            'definition': 'All durable starts in [start,end); only atomically linked terminal outcomes before end finish that cohort. Later outcomes do not cross the cutoff; incomplete attempts remain in the denominator. Legacy terminal-only records are counted separately and never backfilled.',
            'boundary': 'Point-in-time recorded terminal outcomes, not current metadata/byte validity, human approval or production KPI. Starts lost before durable storage, requests outside this service and pre-upgrade history cannot be enumerated. No source/output files are read; only aggregates are emitted.'}
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError, sqlite3.Error):
        return unavailable('Verification lifecycle failed identity, digest, sequence, timestamp or atomic terminal binding validation.')


def recorded_verification_metrics(engineering, survey, selected, networks, adjustments, start, end):
    names = {row[0] for row in engineering.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing = unavailable('No durable verification attempt table; historical checks cannot be inferred.')
    if 'engineering_verification_attempts' not in names:
        return {'recordedStrictReverificationCoverage': missing, 'recordedVerificationAttemptSuccessRate': missing}
    # Use exact serialized-event bytes for the audit digest, and portable typed
    # JSON digests for current metadata. No filesystem outputs are re-read here.
    rows = engineering.execute('SELECT sequence,id,project_id,manifest_id,started_at,completed_at,outcome,record_hash,data_json FROM engineering_verification_attempts ORDER BY sequence').fetchall()
    events = []
    latest = {}
    seen_ids = set()
    try:
        for sequence, identity, pid, mid, began, ended, outcome, digest, serialized in rows:
            event = json.loads(serialized)
            if (hashlib.sha256(serialized.encode('utf-8')).hexdigest() != digest
                    or identity in seen_ids or not identity
                    or event.get('schemaVersion') != 1
                    or any(event.get(key) != value for key, value in [('id', identity), ('projectId', pid), ('manifestId', mid), ('startedAt', began), ('completedAt', ended), ('outcome', outcome)])
                    or outcome not in ('passed', 'failed', 'error')):
                raise ValueError('invalid audit identity')
            seen_ids.add(identity)
            began_at, ended_at = instant(began), instant(ended)
            if began_at > ended_at:
                raise ValueError('backwards audit time')
            if ended_at < end:
                latest[(pid, mid)] = event
            if start <= ended_at < end:
                events.append(event)
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        invalid = unavailable('Verification audit identity, digest or timestamp integrity failed; no earlier passing event is substituted.')
        return {'recordedStrictReverificationCoverage': invalid, 'recordedVerificationAttemptSuccessRate': invalid}

    allowed_tables = {'engineering_projects', 'engineering_manifests', 'engineering_runs', 'engineering_datasets', 'engineering_analyses'}
    cache = {}
    def identity_checked_records(connection, table, nested=None):
        cursor = connection.execute('SELECT * FROM ' + table)
        columns = [item[0] for item in cursor.description]
        if 'id' not in columns or 'data_json' not in columns:
            raise ValueError('durable identity columns unavailable')
        result = []
        bindings = {'id': 'id', 'project_id': 'projectId', 'revision': 'revision', 'network_id': 'networkId',
                    'dataset_id': 'datasetId', 'reference_adjustment_id': 'referenceAdjustmentId',
                    'current_adjustment_id': 'currentAdjustmentId', 'input_hash': 'inputHash',
                    'created_at': 'createdAt', 'updated_at': 'updatedAt'}
        for values in cursor:
            durable = dict(zip(columns, values))
            data = json.loads(durable['data_json'])
            identity = data[nested] if nested else data
            if any(identity.get(key) != durable[column] for column, key in bindings.items() if column in durable):
                raise ValueError('durable identity mismatch')
            result.append(data)
        return indexed(result, nested)
    def current_row(table, identity):
        if table not in allowed_tables or table not in names:
            return None
        if table not in cache:
            cache[table] = identity_checked_records(engineering, table)
        return cache[table].get(identity)
    deformation_cache = None
    network_cache = None
    adjustment_cache = None
    def still_bound(event):
        nonlocal deformation_cache, network_cache, adjustment_cache
        try:
            binding = event['bindings']
            verification = event['verification']
            if (event['outcome'] != 'passed' or event['bindingStable'] is not True or binding['complete'] is not True
                    or binding['algorithm'] != 'typed-json-sha256-v1' or not verification or verification.get('valid') is not True
                    or verification.get('projectId') != event['projectId'] or verification.get('manifestId') != event['manifestId']
                    or verification.get('reviewStatus') != 'draft'):
                return False
            checked = instant(verification['checkedAt'])
            if not instant(event['startedAt']) <= checked <= instant(event['completedAt']):
                return False
            manifest = current_row('engineering_manifests', event['manifestId'])
            if not manifest or manifest.get('projectId') != event['projectId'] or manifest.get('reviewStatus') != 'draft':
                return False
            required_rows = {('engineering_manifests', manifest['id']), ('engineering_projects', event['projectId']), ('engineering_runs', manifest['runId'])}
            required_rows.update(('engineering_datasets', item['id']) for item in manifest['inputDatasets'])
            required_rows.update(('engineering_analyses', identity) for identity in manifest['analyses'])
            actual_rows = [(item['table'], item['id']) for item in binding['engineeringRows']]
            if len(actual_rows) != len(set(actual_rows)) or set(actual_rows) != required_rows:
                return False
            for item in binding['engineeringRows']:
                current = current_row(item['table'], item['id'])
                if (not current or (item['table'] != 'engineering_projects' and current.get('projectId') != event['projectId'])
                        or snapshot_hash(current) != item['hash']):
                    return False
            required_networks = {item['networkId'] for item in manifest['adjustments']}
            for item in manifest['deformations']:
                # Deformation-only evidence must include both epoch networks.
                required_networks.update(epoch['networkId'] for epoch in item['epochs'])
            if len(binding['surveyNetworks']) != len(required_networks) or {item['id'] for item in binding['surveyNetworks']} != required_networks:
                return False
            if binding['surveyNetworks'] and network_cache is None:
                network_cache = identity_checked_records(survey, 'survey_networks')
            for item in binding['surveyNetworks']:
                current = network_cache.get(item['id'])
                if not current or current.get('projectId') != event['projectId'] or snapshot_hash(current) != item['hash']:
                    return False
            required_results = {item['id'] for item in manifest['adjustments']}
            required_results.update(epoch['resultId'] for item in manifest['deformations'] for epoch in item['epochs'])
            if len(binding['surveyResults']) != len(required_results) or {item['id'] for item in binding['surveyResults']} != required_results:
                return False
            if binding['surveyResults'] and adjustment_cache is None:
                adjustment_cache = identity_checked_records(survey, 'survey_adjustments', 'run')
            for item in binding['surveyResults']:
                stored = adjustment_cache.get(item['runId'], {})
                run, result = stored.get('run', {}), stored.get('result', {})
                if (run.get('projectId') != event['projectId'] or run.get('status') != 'completed' or result.get('validation') != 'valid'
                        or result.get('runId') != run.get('id') or result.get('id') != item['id']
                        or any(run.get(key) != item[key] or result.get(key) != item[key] for key in ['networkId', 'inputHash', 'algorithmVersion'])
                        or snapshot_hash(result) != item['hash']):
                    return False
            if len(binding['surveyDeformations']) != len(manifest['deformations']) or {item['id'] for item in binding['surveyDeformations']} != {item['id'] for item in manifest['deformations']}:
                return False
            if binding['surveyDeformations']:
                if deformation_cache is None:
                    deformation_cache = identity_checked_records(survey, 'survey_deformations')
                for item in binding['surveyDeformations']:
                    current = deformation_cache.get(item['id'])
                    if not current or current.get('projectId') != event['projectId'] or snapshot_hash(current) != item['hash']:
                        return False
            required_checks = {'manifest': 'passed', 'outputs': 'passed', 'inputs': 'passed',
                               'surveyReplay': 'passed' if required_networks else 'not-applicable',
                               'sources': 'passed' if required_networks else 'not-applicable'}
            if len(verification['checks']) != len(required_checks) or {item['id']: item['status'] for item in verification['checks']} != required_checks:
                return False
            return True
        except (ValueError, TypeError, KeyError, AttributeError, UnicodeError, sqlite3.Error):
            return False

    drafts = [manifest for _, manifest in selected if manifest.get('reviewStatus') == 'draft']
    identities = [(item.get('projectId'), item.get('id')) for item in drafts]
    valid_denominator = all(isinstance(pid, str) and pid and isinstance(mid, str) and mid for pid, mid in identities) and len(set(identities)) == len(identities)
    matching = [event for key, event in latest.items() if key in identities and still_bound(event)] if valid_denominator else []
    passed_attempts = sum(still_bound(event) for event in events)
    boundary = 'Historical checks only; metadata bindings match this database snapshot. Output/source bytes are not re-read, and this is not current validity, human approval or population completeness.'
    coverage = {
        'value': len(matching) / len(drafts) if drafts else None,
        'numerator': len(matching), 'denominator': len(drafts),
        'status': 'measured' if drafts else 'no-samples',
        'definition': 'Distinct draft manifests created in period whose latest recorded terminal check before period end passed with unchanged metadata bindings; subsequent failure supersedes a previous pass.',
        'checkedAtRange': [min(e['verification']['checkedAt'] for e in matching), max(e['verification']['checkedAt'] for e in matching)] if matching else None,
        'boundary': boundary
    } if valid_denominator else unavailable('Draft identities are missing or duplicated; denominator cannot be established.')
    return {
        'recordedStrictReverificationCoverage': coverage,
        'recordedVerificationAttemptSuccessRate': {
            'value': passed_attempts / len(events) if events else None,
            'numerator': passed_attempts, 'denominator': len(events), 'status': 'measured' if events else 'no-samples',
            'definition': 'Recorded terminal attempts completed in period that passed and still match snapshot metadata / all recorded terminal attempts in period, including failures and lookup errors. Crashes or failed audit writes have no event and are not counted.',
            'outcomes': {key: sum(e['outcome'] == key for e in events) for key in ['passed', 'failed', 'error']},
            'boundary': boundary}}


def measure(engineering, survey, cohort, start, end):
    if cohort not in ('candidate-fixture', 'production') or start >= end:
        raise ValueError('invalid cohort or period')
    projects = indexed(records(engineering, 'engineering_projects'))
    networks = indexed(records(survey, 'survey_networks'))
    adjustments = indexed(records(survey, 'survey_adjustments'), 'run')
    manifests = records(engineering, 'engineering_manifests')
    issues = {'invalidManifestTime': 0, 'invalidBoundInputTime': 0,
              'missingOrMismatchedBinding': 0, 'nonForwardTime': 0}
    selected = []
    history = []
    for manifest in manifests:
        try:
            timestamp = instant(manifest.get('createdAt'))
        except ValueError:
            issues['invalidManifestTime'] += 1
            continue
        if timestamp < end:
            history.append((timestamp, manifest))
        if start <= timestamp < end:
            selected.append((timestamp, manifest))
    first_draft = {}
    linked_manifests = 0
    for timestamp, manifest in sorted(history, key=lambda pair: pair[0]):
        if manifest.get('reviewStatus') != 'draft':
            continue
        pid = manifest.get('projectId')
        links = manifest.get('adjustments', [])
        if pid not in projects or not links or not manifest.get('outputs') or manifest.get('validation', {}).get('valid') is not True:
            issues['missingOrMismatchedBinding'] += 1
            continue
        inputs = []
        valid = True
        for link in links:
            record = adjustments.get(link.get('runId'), {})
            run = record.get('run', {})
            result = record.get('result', {})
            network = networks.get(link.get('networkId'), {})
            if (not network or network.get('projectId') != pid or run.get('projectId') != pid
                    or run.get('networkId') != network.get('id') or run.get('status') != 'completed'
                    or link.get('id') != result.get('id') or link.get('inputHash') != result.get('inputHash')
                    or result.get('inputHash') != run.get('inputHash') or not run.get('inputHash')
                    or result.get('runId') != run.get('id') or result.get('networkId') != network.get('id')
                    or not run.get('algorithmVersion')
                    or link.get('algorithmVersion') != run.get('algorithmVersion')
                    or result.get('algorithmVersion') != run.get('algorithmVersion')
                    or result.get('validation') != 'valid'):
                valid = False
                issues['missingOrMismatchedBinding'] += 1
                break
            try:
                imported = instant(network.get('createdAt'))
                completed = instant(run.get('completedAt'))
            except ValueError:
                valid = False
                issues['invalidBoundInputTime'] += 1
                break
            if not imported <= completed <= timestamp:
                valid = False
                issues['nonForwardTime'] += 1
                break
            inputs.append(imported)
        if valid:
            if timestamp >= start:
                linked_manifests += 1
            # Read pre-period history so repeat deliveries do not become first drafts.
            first_draft.setdefault(pid, (timestamp, (timestamp - min(inputs)).total_seconds()))
    durations = [duration for timestamp, duration in first_draft.values() if timestamp >= start]
    statuses = {}
    for _, item in selected:
        status = item.get('reviewStatus')
        # Bounded known states only; do not leak arbitrary persisted text.
        status = status if status in ('draft', 'reviewed', 'approved', 'rejected') else 'other'
        statuses[status] = statuses.get(status, 0) + 1
    verification_metrics = recorded_verification_metrics(engineering, survey, selected, networks, adjustments, start, end)
    return {
        'schemaVersion': 1, 'cohort': cohort,
        'cohortProvenance': 'Caller-declared database cohort; not independently certified. Candidate metrics must not be pooled with production.',
        'period': {'startInclusive': start.isoformat(), 'endExclusive': end.isoformat(), 'timezone': 'UTC'},
        'measurementBoundary': 'Snapshot metadata only; no byte verification, recomputation, standards assessment or signature validation.',
        'counts': {'projectsInSnapshot': len(projects), 'networksInSnapshot': len(networks),
                   'manifestsInPeriod': len(selected), 'manifestReviewStates': statuses,
                   'draftManifestsWithConsistentStoredBindings': linked_manifests,
                   'projectsWithFirstBoundDraftInPeriod': len(durations)},
        'importToFirstBoundDraftSeconds': {
            'value': statistics.median(durations) if durations else None,
            'statistic': 'median', 'sampleSize': len(durations),
            'definition': 'Earliest bound network import to first qualifying draft in retained project history, selecting first drafts in period; includes waiting and user interaction. Deleted history cannot be detected.',
            'status': 'measured' if durations else 'no-samples',
            'range': [min(durations), max(durations)] if durations else None},
        'approvedTraceableProductionProjects': unavailable('Current records lack verifiable human approval and digital signatures; draft counts are separate.'),
        'productionRepresentativeness': unavailable('The cohort label is a caller declaration; collection provenance and population coverage are not recorded.'),
        'firstAttemptImportSuccessRate': unavailable('Product-wide first tasks and population coverage are not certified. The recorded first-observed file-key subset is reported separately.'),
        'recordedImportAttempts': recorded_import_metrics(survey, start, end),
        'recordedVerificationLifecycle': recorded_verification_lifecycle(engineering, start, end),
        'mediumLeveling30MinuteTarget': unavailable('Medium-network size and representative production cohort have not been defined or collected.'),
        'numericalReproducibilityRate': unavailable('Requires explicit strict replay outcomes for every selected run; stored bindings are not replay.'),
        'strictReverificationCoverage': unavailable('Current strict validity requires re-reading output/source bytes and live replay. Recorded point-in-time checks are reported separately.'),
        **verification_metrics,
        'standardsTraceabilityRate': unavailable('Free-text citations do not prove authoritative version/clause verification.'),
        'unverifiedNumbersInDeliverables': unavailable('Requires complete artifact value provenance checks, not record counts.'),
        'licenseViolations': unavailable('Requires an independent license audit for the measured scope.'),
        'englishChineseResidue': unavailable('Requires English-rendered state coverage and raw-evidence exclusions.'),
        'oneClickEvidenceQuestionCoverage': unavailable('Requires an inventory of eligible result surfaces and verified question actions; database counts do not measure UI coverage.'),
        'dataQualityScope': 'Manifest timestamps across snapshot; binding and input-time checks for draft history before period end.',
        'dataQuality': issues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engineering-db', type=Path, required=True)
    parser.add_argument('--survey-db', type=Path, required=True)
    parser.add_argument('--cohort', choices=['candidate-fixture', 'production'], required=True)
    parser.add_argument('--start', required=True, help='ISO timestamp including timezone')
    parser.add_argument('--end', required=True, help='Exclusive ISO timestamp including timezone')
    args = parser.parse_args()
    try:
        start, end = instant(args.start), instant(args.end)
        with readonly_database(args.engineering_db) as eng, readonly_database(args.survey_db) as survey:
            result = measure(eng, survey, args.cohort, start, end)
            result['snapshotConsistency'] = 'Independent read transactions; cross-database bindings checked. Use stopped-app copies for a common snapshot.'
            print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError, KeyError, AttributeError, sqlite3.Error, OSError):
        # Persisted values and paths may be sensitive; fail without echoing them.
        print('Measurement failed: check database availability, schema, record integrity, cohort and timezone-aware period.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
