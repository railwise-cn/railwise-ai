#!/usr/bin/env python3
"""Read-only synthetic packaged assessment verifier; never drives or certifies GUI.

Uses SQLite mode=ro/query_only, original-byte hashes and an independent Fraction
scoring oracle. No production services, HTTP or write SQL are called. Run while
GUI is idle; separate SQLite snapshots are not a cross-database transaction.
"""
import argparse
import json
from pathlib import Path
import sqlite3
import sys
from scoring_oracle import require, sha, digest, json_text, load_json, verify_row

ZERO = '0' * 64
HERE = Path(__file__).resolve().parent
BOUNDARIES = {
    'purpose': 'declared-record-linkage-only', 'associationTrust': 'caller-declared-not-authenticated',
    'inspectionEvidenceAuthenticity': 'not-verified', 'materialCompletenessBeyondDeclaration': 'not-evaluated',
    'populationCompleteness': 'caller-declared-not-verified', 'classificationAuthenticity': 'not-verified',
    'organizationIndependence': 'not-evaluated', 'stageCompletion': 'not-evaluated', 'checkpointTrust': 'local-records-only',
    'standardConformity': 'not-evaluated', 'humanSignatureVerification': 'not-evaluated', 'engineeringDecision': 'not-evaluated',
    'approvalCapability': 'none', 'formalResultsModified': False, 'deliverableVerification': 'not-performed-by-assessment',
    'deliverableNumericalReplay': 'not-performed-by-assessment',
}


def connect(root, filename):
    path = (root / filename).resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    return db


def row(db, table, pid, identity):
    found = db.execute(f'SELECT * FROM {table} WHERE project_id=? AND id=?', (pid, identity)).fetchone()
    require(found is not None, f'Missing {table} row {identity} in selected project')
    return dict(found)


def without(value, *keys):
    return {key: item for key, item in value.items() if key not in keys}


def own(db, table, pid, identity):
    saved = row(db, table, pid, identity)
    data = load_json(saved['data_json'])
    raw = saved['request_bytes']
    require(isinstance(raw, bytes), 'Assessment request must be a BLOB')
    require(data['requestJson'].encode('utf-8') == raw, 'Raw assessment request changed')
    require(load_json(raw) == data['request'], 'Assessment normalized request differs')
    require(sha(raw) == data['requestSha256'] and len(raw) == data['requestSizeBytes'], 'Assessment request digest/length')
    content = 'planHash' if table == 'assessment_plans' else 'recordHash'
    require(digest(without(data, content)) == data[content] == saved['content_hash'], 'Assessment content digest')
    for sql, field in [('id', 'id'), ('project_id', 'projectId'), ('project_revision', 'projectRevision'),
                       ('project_binding_hash', 'projectBindingHash'), ('request_hash', 'requestSha256'), ('created_at', 'createdAt')]:
        require(saved[sql] == data[field], 'Assessment SQL binding: ' + sql)
    require(saved['idempotency_key'] == data['request']['idempotencyKey'], 'Assessment idempotency binding')
    require(data['request']['acknowledged'] is True and data['request']['expectedProjectRevision'] == data['projectRevision'], 'Assessment acknowledgement/revision')
    require(digest({**without(saved, 'storage_hash', 'request_bytes'), 'request_bytes_sha256': sha(raw)}) == saved['storage_hash'], 'Assessment storage digest')
    require(all(data.get(k) == v for k, v in BOUNDARIES.items()), 'Assessment trust boundaries')
    return data


def quality(db, pid, identity, kind):
    saved = row(db, 'quality_objects', pid, identity)
    require(saved['kind'] == kind and digest(without(saved, 'record_hash')) == saved['record_hash'], 'Retention object digest/kind')
    data = load_json(saved['data_json'])
    require(data['id'] == identity and data['projectId'] == pid, 'Retention object identity')
    return data


def engineering_snapshot(db, pid, manifest_id):
    project_row = db.execute('SELECT * FROM engineering_projects WHERE id=?', (pid,)).fetchone()
    require(project_row is not None, 'Project missing')
    p = load_json(project_row['data_json'])
    manifest_row = row(db, 'engineering_manifests', pid, manifest_id)
    manifest = load_json(manifest_row['data_json'])
    require(manifest['reviewStatus'] == 'draft', 'Fixture manifest must remain draft')
    workspace = Path(p['workspace']).resolve(strict=True)
    files = {}
    for output in manifest['outputs']:
        path = (workspace / output['path']).resolve(strict=True)
        require(path.is_relative_to(workspace), 'Output escaped project workspace')
        content = path.read_bytes()
        require(sha(content) == output['sha256'] and len(content) == output['sizeBytes'], 'Current output bytes differ')
        files[output['path']] = {'sha256': sha(content), 'sizeBytes': len(content)}
    manifest_path = workspace / '.workwise' / 'deliverables' / pid / manifest['runId'] / 'manifest.json'
    content = manifest_path.read_bytes()
    require(load_json(content) == manifest, 'Stored manifest and manifest file differ')
    files[str(manifest_path.relative_to(workspace))] = {'sha256': sha(content), 'sizeBytes': len(content)}
    audits = [dict(item) for item in db.execute('SELECT * FROM engineering_verification_attempts WHERE project_id=? ORDER BY sequence', (pid,))]
    return p, manifest, {'projectRow': dict(project_row), 'manifestRow': manifest_row, 'files': files,
                         'verificationAuditCount': len(audits), 'verificationAuditDigest': digest(audits)}


def references(model):
    result = list(model['evidenceRefs'])
    for leaf in model['leaves']:
        if leaf['state'] != 'checked':
            result.extend(leaf['evidenceRefs'])
        elif leaf['record']['kind'] == 'deduction':
            result.extend(leaf['record']['defects']['evidenceRefs'])
        else:
            accuracy = leaf['record']['model']
            result.extend(accuracy['aEvidenceRefs'])
            for item in accuracy['items']:
                result.extend(item['evidenceRefs'])
            if accuracy['aggregation']['kind'] == 'weighted':
                result.extend(accuracy['aggregation']['evidenceRefs'])
    return list(dict.fromkeys(result))


def inspect(args):
    dbs = {name: connect(args.root, filename) for name, filename in {
        'engineering': 'engineering.sqlite3', 'assessment': 'survey-quality-assessment.sqlite3',
        'retention': 'survey-quality.sqlite3', 'sampling': 'survey-sampling.sqlite3', 'scoring': 'survey-quality-scoring.sqlite3',
    }.items()}
    try:
        plan = own(dbs['assessment'], 'assessment_plans', args.project, args.plan)
        snap = plan['snapshot']
        project, manifest, baseline = engineering_snapshot(dbs['engineering'], args.project, snap['artifact']['manifestId'])
        binding = {'id': project['id'], 'revision': project['revision'], 'workspace': project['workspace']}
        require(snap['project'] == binding and digest(binding) == plan['projectBindingHash'], 'Current project binding changed')
        if args.capture_baseline:
            return {'mode': 'baseline', 'guiExecutionVerified': False, 'projectId': args.project, 'planId': args.plan, 'snapshot': baseline}
        require(args.baseline is not None, '--baseline is required for final verification')
        old = load_json(args.baseline.read_bytes())
        require(old['projectId'] == args.project and old['planId'] == args.plan and old['snapshot'] == baseline, 'Project, draft, output or verification-audit changed since GUI baseline')
        q = dbs['retention']
        rp = quality(q, args.project, snap['retentionPlan']['id'], 'plan')
        artifact = quality(q, args.project, snap['artifact']['id'], 'artifact')
        rr = quality(q, args.project, snap['retentionRecordId'], 'record')
        require(rp == snap['retentionPlan'] and artifact == snap['artifact'], 'Frozen retention source differs')
        require(rr['planId'] == rp['id'] and rr['planHash'] == digest(rp) == snap['retentionPlanDigest'], 'Retention plan/record binding')
        require(digest(manifest) == artifact['manifestHash'] == rp['manifestHash'], 'Manifest canonical hash')
        descriptor = {k: artifact[k] for k in ('schemaVersion', 'projectId', 'manifestId', 'manifestHash', 'members')}
        require(digest(descriptor) == artifact['bundleHash'] == rp['artifactHash'] == rr['artifactHash'], 'Bundle digest')
        for member in artifact['members']:
            content = (Path(project['workspace']) / member['path']).read_bytes()
            require(sha(content) == member['sha256'] and len(content) == member['sizeBytes'], 'Artifact member bytes')
            require((args.root / 'quality-blobs' / member['sha256']).read_bytes() == content, 'Retained bytes differ from source')
        require((args.root / 'quality-blobs' / artifact['snapshotEvidenceSha256']).read_bytes() == json_text(descriptor, sort=True).encode(), 'Descriptor retained bytes')
        events, previous = [], ZERO
        for saved_ in q.execute('SELECT * FROM quality_events WHERE project_id=? AND record_id=? ORDER BY sequence', (args.project, rr['id'])):
            saved = dict(saved_); envelope = load_json(saved['data_json']); event = envelope['event']; action = event['event']
            require(digest(envelope) == saved['record_hash'] and event['id'] == saved['id'] and event['sequence'] == saved['sequence'] == len(events) + 1, 'Event storage/sequence')
            require(event['previousHash'] == previous and event['thisHash'] == sha(json_text(without(event, 'thisHash'))), 'Event hash chain')
            require(envelope['projectId'] == event['projectId'] == args.project and envelope['recordId'] == rr['id'] and event['artifactSha256'] == artifact['bundleHash'], 'Event identity')
            require(event['actor'] == {'id': 'survey-quality-workspace', 'kind': 'system'} and event['stage'] == 'workspace-evidence', 'Unexpected event actor/stage')
            require(action['kind'] in ('check', 'artifact-check') and action['outcome'] == 'passed' and action['checkId'] in rp['requiredCheckIds'], 'Unexpected retention event')
            if action['checkId'] == 'artifact-bytes':
                require(action['evidenceSha256'] == artifact['bundleHash'] and envelope['evidenceId'] is None, 'Artifact check identity')
            else:
                evidence = quality(q, args.project, envelope['evidenceId'], 'evidence')
                requirement = next(r for r in rp['requiredEvidence'] if 'evidence:' + r['id'] == action['checkId'])
                member = next(m for m in artifact['members'] if m['id'] == requirement['memberId'])
                require(evidence['artifactId'] == artifact['id'] and evidence['memberId'] == member['id'] and evidence['sha256'] == member['sha256'] == action['evidenceSha256'], 'Evidence member binding')
            events.append(event); previous = event['thisHash']
        heads = [dict(r) for r in q.execute('SELECT * FROM quality_heads WHERE record_id=? ORDER BY event_count', (rr['id'],))]
        require(len(heads) == len(events) + 1, 'Head count')
        for index, head in enumerate(heads):
            expected = events[index-1]['thisHash'] if index else ZERO
            require(head['event_count'] == index and head['head_hash'] == expected and head['record_hash'] == digest({'recordId': rr['id'], 'eventCount': index, 'headHash': expected}), 'Head checkpoint')
        pop_row = row(dbs['sampling'], 'sampling_populations', args.project, snap['population']['id'])
        population = load_json(pop_row['data_json'])
        require(digest({**without(pop_row, 'record_hash', 'definition_bytes'), 'definition_bytes_sha256': sha(pop_row['definition_bytes'])}) == pop_row['record_hash'], 'Population SQL digest')
        require(pop_row['definition_bytes'] == population['definitionStatement'].encode() and sha(pop_row['definition_bytes']) == population['definitionEvidenceSha256'], 'Population original definition')
        require(without(population, 'orderedUnitProductIds') == snap['population'] and population['populationHash'] == sha(json_text(['survey-unit-product-frame-1', population['orderedUnitProductIds']])), 'Population snapshot/frame')
        run_row = row(dbs['sampling'], 'sampling_runs', args.project, snap['run']['id'])
        run = load_json(run_row['data_json']); sample_plan = run['plan']
        require(digest(without(run_row, 'record_hash')) == run_row['record_hash'] and without(run, 'plan') == snap['run'], 'Sampling SQL/frozen run')
        require(run['round'] == 1 and run['inspectionMode'] == 'census' and run['stage'] == 'final-office', 'Verifier scope is this GUI census fixture only')
        require(run['runHash'] == digest(without(run, 'plan', 'runHash')) and sample_plan['planHash'] == sha(json_text(without(sample_plan, 'planHash'))), 'Sampling plan/run digest')
        require(sample_plan['requestHash'] == sha(json_text(sample_plan['request'])), 'Sampling request digest')
        ids = [unit for batch in sample_plan['batches'] for unit in batch['selectedUnitProductIds']]
        require(ids == population['orderedUnitProductIds'] == snap['selectedUnitIds'] == [u['unitId'] for u in plan['request']['unitMaterials']], 'Entire census scope/order')
        require(len(ids) == 2 and digest(ids) == snap['sampleIdsHash'], 'Two-unit GUI fixture/sequence hash')
        scores = {}; results = []; seen_cases = set()
        for r in dbs['assessment'].execute('SELECT id FROM assessments WHERE project_id=? ORDER BY created_at,id', (args.project,)):
            record = own(dbs['assessment'], 'assessments', args.project, r['id'])
            if record['assessmentPlanId'] != args.plan:
                continue
            require(record['planHash'] == record['request']['expectedPlanHash'] == plan['planHash'] and record['projectSnapshot'] == binding, 'Assessment plan/current project')
            vector = record['sourceVector']; n = vector['retentionEventCount']; require(0 <= n <= len(events), 'Assessment event prefix length')
            require(vector['retentionHeadHash'] == (events[n-1]['thisHash'] if n else ZERO), 'Saved assessment head absent from immutable chain')
            expected_vector = {'manifestId': manifest['id'], 'manifestHash': artifact['manifestHash'], 'artifactId': artifact['id'], 'bundleHash': artifact['bundleHash'], 'retentionPlanId': rp['id'], 'retentionPlanDigest': digest(rp), 'retentionRecordId': rr['id'], 'populationId': population['id'], 'populationHash': population['populationHash'], 'populationDefinitionHash': population['definitionEvidenceSha256'], 'samplingRunId': run['id'], 'samplingRunHash': run['runHash'], 'samplingPlanHash': run['planHash'], 'sampleIdsHash': digest(ids), 'profile': snap['profile']}
            require(all(vector[k] == v for k, v in expected_vector.items()), 'Assessment source vector binding')
            checks = []
            for check_id in rp['requiredCheckIds']:
                matched = next((e for e in reversed(events[:n]) if e['event']['checkId'] == check_id), None)
                checks.append({'checkId': check_id, 'status': 'passed' if matched else 'missing', **({'eventId': matched['id']} if matched else {})})
            rows, bindings = [], []
            for unit in plan['request']['unitMaterials']:
                materials = []
                for mapping in unit['requirements']:
                    required = next(x for x in rp['requiredEvidence'] if 'evidence:' + x['id'] == mapping['retentionCheckId'])
                    require(required['memberId'] == mapping['memberId'], 'Declared mapping changed member')
                    check = next(x for x in checks if x['checkId'] == mapping['retentionCheckId'])
                    materials.append({**mapping, 'status': 'retained-bytes-linked' if check['status'] == 'passed' else 'missing-retention-check', 'eventId': check.get('eventId')})
                selected = next((s for s in record['request']['unitScores'] if s['unitId'] == unit['unitId']), None)
                projection, refs, complete = None, [], False
                if selected:
                    sid = selected['scoringRecordId']
                    if sid not in scores:
                        saved = row(dbs['scoring'], 'quality_scoring_records', args.project, sid); score = load_json(saved['data_json'])
                        declaration = score['declaration']; case = 'child-veto' if score['outcome'] == 'nonconforming' else 'full'
                        verify_row(saved, case, score['declarationJson'].encode(), declaration, args.project)
                        require(score['projectSnapshot'] == binding, 'Scoring current project binding')
                        scores[sid] = score
                    score = scores[sid]; declaration = score['declaration']
                    require(declaration['operation'] == 'unit' and declaration['unitId'] == unit['unitId'] and declaration['productProfileId'] == snap['profile']['profileId'], 'Scoring role/unit/profile')
                    projection = {'recordId': sid, 'associationTiming': 'existing-record-linked-after-calculation', 'declaredTargetAssociation': 'caller-declared-not-authenticated', 'scopeAssessment': score['scopeAssessment'], 'result': score['result']['result']}
                    refs = [{'reference': ref, 'resolved': any(m['reference'] == ref and m['status'] == 'retained-bytes-linked' for m in materials)} for ref in references(declaration)]
                    complete = score['scopeAssessment'] == 'complete-declared-product-profile' and score['outcome'] in ('calculated', 'nonconforming')
                    bindings.append({'unitId': unit['unitId'], 'recordId': sid, **{k: score[k] for k in ('requestSha256', 'declarationSha256', 'modelHash', 'resultHash', 'recordHash')}})
                rows.append({'unitId': unit['unitId'], 'materials': materials, 'score': projection, 'references': refs, 'fullProfileResult': complete})
            require(bindings == vector['scoring'], 'Scoring source vector')
            counts = {'expectedUnits': len(rows), 'linkedScores': len(bindings), 'fullProfileUnits': sum(u['fullProfileResult'] for u in rows), 'requiredMaterialMappings': sum(len(u['materials']) for u in rows), 'satisfiedMaterialMappings': sum(m['status'] == 'retained-bytes-linked' for u in rows for m in u['materials']), 'unresolvedReferences': sum(not r['resolved'] for u in rows for r in u['references'])}
            retention_complete = all(c['status'] == 'passed' for c in checks) and counts['requiredMaterialMappings'] == counts['satisfiedMaterialMappings']
            score_complete = counts['fullProfileUnits'] == len(rows)
            veto = any(u['score'] and u['score']['result']['state'] == 'nonconforming' for u in rows)
            result = {'bindingIntegrity': 'verified-current-local-records', 'unitRows': rows, 'counts': counts, 'originalRetentionChecks': checks, 'retentionCoverage': 'complete-declared-requirements' if retention_complete else 'incomplete-declared-requirements', 'scoreCoverage': 'complete-full-profile-unit-results' if score_complete else 'incomplete-full-profile-unit-results', 'declaredResultSummary': 'contains-declared-nonconforming' if veto else 'all-declared-unit-results-calculated' if score_complete else 'unresolved', 'overallLinkage': 'complete-declared-linkage' if retention_complete and score_complete and not counts['unresolvedReferences'] else 'incomplete-declared-linkage'}
            require(result == record['result'] and digest(result) == record['resultHash'], 'Independent linkage recomputation differs')
            require(record['manifestReviewStatus'] == 'draft', 'Assessment changed draft echo')
            case = 'complete' if result['overallLinkage'] == 'complete-declared-linkage' and not veto else 'veto-with-missing' if veto and not score_complete else 'missing' if not bindings else 'other'
            seen_cases.add(case)
            results.append({'id': record['id'], 'case': case, 'recordHash': record['recordHash'], 'counts': counts, 'currentSourceChanged': n != len(events), 'retentionEventCount': n})
        if args.require_cases:
            require({'complete', 'missing', 'veto-with-missing'} <= seen_cases, 'Required three GUI-created cases are not all present')
        for exported in args.export:
            record = load_json(exported.read_bytes()); saved = own(dbs['assessment'], 'assessments', args.project, record['id'])
            require(record == saved and record['assessmentPlanId'] == args.plan, 'Native export differs from saved record')
        return {'verified': True, 'guiExecutionVerified': False, 'professionalApproval': False, 'crossDatabaseAtomicityClaimed': False, 'scope': 'synthetic-two-unit-final-office-census-full-and-veto-only', 'projectId': args.project, 'planId': args.plan, 'baselineUnchanged': True, 'currentRetentionEvents': len(events), 'independentScoresChecked': len(scores), 'requiredCasesPresent': {'complete', 'missing', 'veto-with-missing'} <= seen_cases, 'nativeExportFilesChecked': len(args.export), 'records': results}
    finally:
        for db in dbs.values():
            db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='Directory containing the five engineering SQLite databases')
    parser.add_argument('--project', required=True)
    parser.add_argument('--plan', required=True, help='GUI-created assessment_plan_* ID')
    parser.add_argument('--capture-baseline', action='store_true')
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--require-cases', action='store_true')
    parser.add_argument('--export', type=Path, action='append', default=[])
    try:
        print(json.dumps(inspect(parser.parse_args()), ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(json.dumps({'verified': False, 'guiExecutionVerified': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
