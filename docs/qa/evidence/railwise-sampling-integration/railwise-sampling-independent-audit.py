#!/usr/bin/env python3
"""Independent sampling audit; Python stdlib, SQLite mode=ro/query_only only.

Run with the candidate idle: the engineering and sampling databases cannot have
one atomic snapshot. data_version checks detect commits during the audit but do
not turn local hashes into signatures, immutable external custody or professional
approval. No product module is imported. Only the optional report is written.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import hmac
import json
from pathlib import Path
import re
import sqlite3
import sys

MAX_SAFE = 9007199254740991
MAX_ROWS = 8192
TABLE = [(1,20,3),(21,40,5),(41,60,7),(61,80,9),(81,100,10),(101,120,11),
         (121,140,12),(141,160,13),(161,180,14),(181,200,15),(201,232,17),
         (233,282,20),(283,362,24),(363,487,30),(488,686,40),(687,1000,56)]
SOURCE = {'standard':'GB/T 24356-2023','table':'1','clauses':'4.2.2(b);4.2.3(b);4.2.4(c);5.1;5.2;5.3',
 'officialUrl':'https://zrzy.guizhou.gov.cn/wzgb/ztzl/lszt/zrzyzljc/202308/P020230829590929227708.pdf',
 'sourceSha256':'96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487',
 'tablePrintedPage':5,'tablePdfPage':8,'tablePagePngSha256':'6bf3dbeaa964903ab5504c8a3cad2a4c7e1f3e97d7ddf10f6153f4b4aaa9d79c',
 'stagePdfPage':6,'stagePagePngSha256':'94f9323e9653435a1e14c36ed79c04a898a7150c09282790cc4dfdaa667e9617',
 'sampleMaterialsPdfPage':9,'sampleMaterialsPagePngSha256':'5575818fd93325a1c6914f745bb96a848a20d68d3375b0b9f1bfd923669f5b9f',
 'tableEncoding':'utf8-json-array-of-inclusive-min-max-nominal-size-triples',
 'tableSha256':'1a5e4aa0cf43412f0663f6ce619d829a703c84dc7c3b67c1eb7c626fa402c363',
 'reviewIdentity':'agent-source-transcription-not-professional-signoff'}
BOUNDARIES = dict(decision='not-evaluated', standardConformity='not-evaluated',
 humanSignatureVerification='not-evaluated', populationCompleteness='caller-declared-not-verified', spatialUniformity='not-evaluated')

class AuditFailure(Exception):
    pass

def need(condition, code):
    if not condition:
        raise AuditFailure(code)

def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()

def string_json(value):
    out = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return ''.join('\\u%04x' % ord(c) if 0xD800 <= ord(c) <= 0xDFFF else c for c in out)

def js_json(value, canonical=False):
    if value is None: return 'null'
    if isinstance(value, bool): return 'true' if value else 'false'
    if isinstance(value, str): return string_json(value)
    if isinstance(value, int) and abs(value) <= MAX_SAFE: return str(value)
    if isinstance(value, (int, float)): raise AuditFailure('unsupported-non-safe-integer-json-number')
    if isinstance(value, (list, tuple)): return '[' + ','.join(js_json(v, canonical) for v in value) + ']'
    if isinstance(value, dict):
        keys = sorted(value, key=lambda k: k.encode('utf-16-be', 'surrogatepass')) if canonical else list(value)
        return '{' + ','.join(string_json(k)+':'+js_json(value[k], canonical) for k in keys) + '}'
    raise AuditFailure('unsupported-json-type')

def digest(value): return sha(js_json(value, True))

def load_json(value):
    need(isinstance(value, str) and len(value.encode('utf-8')) <= 8*1024*1024, 'stored-json-size-or-type')
    def unique(items):
        out = {}
        for key, item in items:
            need(key not in out, 'duplicate-json-key')
            out[key] = item
        return out
    return json.loads(value, object_pairs_hook=unique,
        parse_constant=lambda _v: (_ for _ in ()).throw(AuditFailure('nonfinite-json-number')))

def keys(value, expected):
    need(isinstance(value, dict) and set(value) == set(expected), 'unexpected-record-fields')

JS_TRIM = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
def identifier(value):
    need(isinstance(value, str) and value == value.strip(JS_TRIM) and len(value) > 0, 'invalid-identifier')
    need(not any(0xD800 <= ord(c) <= 0xDFFF for c in value), 'invalid-identifier-unicode')
    need(len(value.encode('utf-16-le')) // 2 <= 200, 'oversized-identifier')

def timestamp(value):
    need(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})',value), 'invalid-timestamp')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    need(parsed.tzinfo is not None, 'unscoped-timestamp')

def integer(value, minimum, maximum):
    need(type(value) is int and minimum <= value <= maximum, 'invalid-integer-range')

def idempotency(value):
    identifier(value)
    integer(len(value.encode('utf-16-le'))//2,8,160)

def table_size(count):
    for lower, upper, size in TABLE:
        if lower <= count <= upper: return size
    raise AuditFailure('batch-outside-source-table')

def frame_hash(ids): return sha(js_json(['survey-unit-product-frame-1', ids]))

def compute_plan(request):
    """Separate Python implementation; ordered serialization matches published v1."""
    required = ['schemaVersion','projectId','populationId','productType','unitProductType','definitionEvidenceSha256',
        'orderedUnitProductIds','populationHash','stage','inspectionMode','round']
    keys(request, required + (['randomSource'] if 'randomSource' in request else []))
    request = {key: request[key] for key in required + (['randomSource'] if 'randomSource' in request else [])}
    need(request['schemaVersion'] == 1 and request['round'] == 1, 'not-first-round')
    need(request['stage'] in ['process','final-office','final-field','acceptance'], 'invalid-inspection-stage')
    mode = request['inspectionMode']
    need(mode in ['census','table-1-simple-random'], 'invalid-inspection-mode')
    need(request['stage'] not in ['process','final-office'] or mode == 'census', 'full-inspection-reduced-to-sampling')
    if mode == 'census': need('randomSource' not in request, 'randomness-in-census')
    else:
        random = request.get('randomSource')
        names = ['seedHex','sourceDescription','receiptSha256','trust']
        keys(random, names)
        request['randomSource'] = {key: random[key] for key in names}
        need(random['trust'] == 'caller-declared-not-authenticated', 'unsupported-seed-trust')
        seed = bytes.fromhex(random['seedHex'])
        need(len(seed) == 32 and seed.hex() == random['seedHex'], 'invalid-seed')
    ids = request['orderedUnitProductIds']
    need(isinstance(ids, list), 'invalid-population-frame')
    integer(len(ids), 1, 10000)
    for item in ids: identifier(item)
    need(len(set(ids)) == len(ids) and request['populationHash'] == frame_hash(ids), 'population-frame-mismatch')
    request_hash = sha(js_json(request))
    count = (len(ids)+999)//1000
    base, remainder = divmod(len(ids), count)
    batches, offset = [], 0
    for batch_index in range(count):
        size = base + (batch_index < remainder)
        members = ids[offset:offset+size]
        offset += size
        nominal = table_size(size)
        sample_size = size if mode == 'census' else min(size, nominal)
        census = size == sample_size
        pool, draws, rejected = members[:], 0, 0
        transcript = hashlib.sha256()
        if not census:
            domain = js_json(['quality-sampling-hmac-sha256-fy-1',request_hash,batch_index])
            for selected_index in range(sample_size):
                width = size-selected_index
                while True:
                    need(draws < 100000, 'random-draw-limit')
                    block = hmac.new(seed, (domain+'\n'+str(draws)).encode('utf-8'), hashlib.sha256).digest()
                    transcript.update(block)
                    draws += 1
                    draw = int.from_bytes(block[:4], 'big')
                    if draw < (2**32//width)*width: break
                    rejected += 1
                chosen = selected_index + draw % width
                pool[selected_index], pool[chosen] = pool[chosen], pool[selected_index]
        batches.append(dict(batchIndex=batch_index, batchSize=size, unitProductIds=members, nominalTableSampleSize=nominal,
            sampleSize=sample_size, census=census, selectedUnitProductIds=pool[:sample_size], randomDrawCount=draws,
            rejectedDrawCount=rejected, randomTranscriptSha256=None if census else transcript.hexdigest()))
    plan = dict(schemaVersion=1, algorithmVersion='quality-sampling-hmac-sha256-fy-1', source=SOURCE, request=request,
        requestHash=request_hash, batchingPolicy='minimum-count-balanced-contiguous-input-frame-extra-first', batches=batches,
        sampleSize=sum(batch['sampleSize'] for batch in batches), **BOUNDARIES)
    # Core v1 puts spatialUniformity after populationCompleteness (as above).
    plan.update(randomSourceVerification='not-applicable' if mode == 'census' else 'caller-declared-not-authenticated',
        previousPlanVerification='not-applicable', sampleMaterialScope='all-materials-of-selected-unit-products-and-clause-5.3.3-supplementary-materials',
        exclusions=['no-stratified-proportional-sampling','no-quality-scoring','no-stage-completion','no-unit-product-inference','no-professional-signoff'])
    plan['planHash'] = sha(js_json(plan))
    return plan

def readonly(path):
    connection = sqlite3.connect(path.resolve(strict=True).as_uri()+'?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    before = connection.execute('PRAGMA data_version').fetchone()[0]
    connection.execute('BEGIN')
    need(connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'sqlite-quick-check')
    return connection, before

def audit(root):
    engineering, e_version = readonly(root/'engineering.sqlite3')
    sampling, s_version = readonly(root/'survey-sampling.sqlite3')
    project_cache, populations, reports = {}, {}, []
    try:
        def project(pid):
            if pid not in project_cache:
                row = engineering.execute('SELECT id,revision,data_json FROM engineering_projects WHERE id=?', (pid,)).fetchone()
                need(row is not None, 'project-not-found')
                value = load_json(row['data_json'])
                need(value['id'] == pid == row['id'] and value['revision'] == row['revision'], 'project-sql-json-identity')
                integer(value['revision'], 1, MAX_SAFE)
                need(isinstance(value['workspace'], str) and Path(value['workspace']).is_absolute(), 'project-workspace-not-absolute')
                project_cache[pid] = {'id':pid, 'revision':value['revision'], 'workspace':value['workspace']}
            return project_cache[pid]
        def rows(table):
            count = sampling.execute('SELECT count(*) FROM '+table).fetchone()[0]
            need(count <= MAX_ROWS, 'audit-total-row-limit')
            return sampling.execute('SELECT * FROM '+table+' ORDER BY id').fetchall()
        pop_fields = ['schemaVersion','id','projectId','projectRevision','projectBindingHash','productType','unitProductType',
            'definitionEvidenceSha256','definitionSizeBytes','populationHash','unitCount','createdAt','definitionTrust',
            'populationCompleteness','definitionStatement','orderedUnitProductIds']
        pop_keys, counts = set(), {}
        for dbrow in rows('sampling_populations'):
            row = dict(dbrow)
            need(isinstance(row['definition_bytes'], bytes) and 0 < len(row['definition_bytes']) <= 65536, 'definition-blob-size-or-type')
            unsigned = {k:v for k,v in row.items() if k not in ['record_hash','definition_bytes']}
            unsigned['definition_bytes_sha256'] = sha(row['definition_bytes'])
            need(digest(unsigned) == row['record_hash'], 'population-sql-row-hash')
            value = load_json(row['data_json']); keys(value, pop_fields)
            integer(value['schemaVersion'],1,1)
            integer(value['projectRevision'],1,MAX_SAFE)
            integer(value['definitionSizeBytes'],1,65536)
            integer(value['unitCount'],1,10000)
            need(value['schemaVersion'] == 1 and value['id'] == row['id'] and value['projectId'] == row['project_id']
                and value['createdAt'] == row['created_at'], 'population-sql-json-identity')
            for name in ['id','projectId','productType','unitProductType']: identifier(value[name])
            timestamp(value['createdAt'])
            declaration = value['definitionStatement']
            need(isinstance(declaration,str) and declaration.strip(JS_TRIM) and not any(0xD800 <= ord(c) <= 0xDFFF for c in declaration), 'invalid-definition-text')
            raw = declaration.encode('utf-8')
            need(raw == row['definition_bytes'] and sha(raw) == value['definitionEvidenceSha256'] and len(raw) == value['definitionSizeBytes'], 'definition-actual-byte-binding')
            ids = value['orderedUnitProductIds']; need(isinstance(ids,list), 'invalid-unit-frame')
            integer(len(ids),1,10000)
            for item in ids: identifier(item)
            need(len(set(ids)) == len(ids) and value['unitCount'] == len(ids) and value['populationHash'] == frame_hash(ids), 'ordered-population-binding')
            need(value['definitionTrust'] == 'user-declared-not-professionally-verified' and value['populationCompleteness'] == 'caller-declared-not-verified', 'population-trust-overclaim')
            current = project(value['projectId'])
            need(value['projectRevision'] == current['revision'] and value['projectBindingHash'] == digest(current), 'stale-project-binding')
            request = dict(idempotencyKey=row['idempotency_key'], expectedProjectRevision=value['projectRevision'], productType=value['productType'],
                unitProductType=value['unitProductType'], definitionStatement=declaration, orderedUnitProductIds=ids)
            idempotency(row['idempotency_key'])
            need(len(js_json(request).encode()) <= 1024*1024 and digest(request) == row['request_hash'], 'population-api-request-hash-or-limit')
            unique = (value['projectId'],row['idempotency_key']); need(unique not in pop_keys,'duplicate-population-idempotency'); pop_keys.add(unique)
            counts[value['projectId']] = counts.get(value['projectId'],0)+1; need(counts[value['projectId']] <= 128,'population-count-limit')
            populations[(value['projectId'],value['id'])] = value
        seen_stages, run_keys, counts = set(), set(), {}
        for dbrow in rows('sampling_runs'):
            row = dict(dbrow)
            need(digest({k:v for k,v in row.items() if k != 'record_hash'}) == row['record_hash'], 'run-sql-row-hash')
            value = load_json(row['data_json'])
            need(value['id'] == row['id'] and value['projectId'] == row['project_id'] and value['populationId'] == row['population_id']
                and value['stage'] == row['stage'] and value['createdAt'] == row['created_at'], 'run-sql-json-identity')
            population = populations.get((value['projectId'],value['populationId'])); need(population is not None,'missing-project-population')
            need(value['projectRevision'] == population['projectRevision'] and value['projectBindingHash'] == population['projectBindingHash'], 'run-project-binding')
            for name in ['id','projectId','populationId']: identifier(value[name])
            timestamp(value['createdAt'])
            api = dict(populationId=value['populationId'],idempotencyKey=row['idempotency_key'],stage=value['stage'],inspectionMode=value['inspectionMode'])
            idempotency(row['idempotency_key'])
            need(digest(api) == row['request_hash'], 'run-api-request-hash')
            expected_request = dict(schemaVersion=1, projectId=value['projectId'], populationId=population['id'], productType=population['productType'],
                unitProductType=population['unitProductType'], definitionEvidenceSha256=population['definitionEvidenceSha256'],
                orderedUnitProductIds=population['orderedUnitProductIds'], populationHash=population['populationHash'], stage=value['stage'],inspectionMode=value['inspectionMode'],round=1)
            if value['inspectionMode'] != 'census':
                random = value['plan']['request']['randomSource']
                need(random['sourceDescription'] == 'Runtime crypto.randomBytes(32); local seed without an independent witness'
                    and random['receiptSha256'] == sha(bytes.fromhex(random['seedHex'])), 'local-seed-receipt-binding')
                expected_request['randomSource'] = random
            recomputed = compute_plan(expected_request)
            need(js_json(recomputed,True) == js_json(value['plan'],True), 'independent-plan-hmac-table-replay')
            expected = dict(schemaVersion=1,id=value['id'],projectId=value['projectId'],projectRevision=population['projectRevision'],projectBindingHash=population['projectBindingHash'],
                populationId=population['id'],populationHash=population['populationHash'],definitionEvidenceSha256=population['definitionEvidenceSha256'],unitCount=population['unitCount'],
                stage=value['stage'],inspectionMode=value['inspectionMode'],round=1,algorithmVersion=recomputed['algorithmVersion'],source=SOURCE,
                requestHash=recomputed['requestHash'],planHash=recomputed['planHash'],sampleSize=recomputed['sampleSize'],batchCount=len(recomputed['batches']),
                batches=[{k:b[k] for k in ['batchIndex','batchSize','nominalTableSampleSize','sampleSize','census']} for b in recomputed['batches']],
                randomSource='not-applicable' if value['inspectionMode']=='census' else 'runtime-generated-local-unwitnessed',createdAt=value['createdAt'],**BOUNDARIES)
            expected['runHash'] = digest(expected); expected['plan'] = recomputed
            need(js_json(expected,True) == js_json(value,True),'run-summary-count-hash-or-trust-binding')
            unique=(value['projectId'],value['populationId'],value['stage']);need(unique not in seen_stages,'same-stage-redraw');seen_stages.add(unique)
            unique=(value['projectId'],row['idempotency_key']);need(unique not in run_keys,'duplicate-run-idempotency');run_keys.add(unique)
            counts[value['projectId']]=counts.get(value['projectId'],0)+1;need(counts[value['projectId']]<=512,'run-count-limit')
            reports.append({'projectId':value['projectId'],'populationId':value['populationId'],'runId':value['id'],'stage':value['stage'],
                'inspectionMode':value['inspectionMode'],'unitCount':value['unitCount'],'sampleSize':value['sampleSize'],'planHash':recomputed['planHash'],'independentReplay':'passed'})
        sampling.rollback(); engineering.rollback()
        need(sampling.execute('PRAGMA data_version').fetchone()[0] == s_version and engineering.execute('PRAGMA data_version').fetchone()[0] == e_version, 'databases-changed-during-audit')
        return {'status':'passed' if reports else 'not-evaluated','populationCount':len(populations),'runCount':len(reports),'runs':reports,
            'reason':None if reports else 'no-sampling-runs-to-verify'}
    finally:
        sampling.close(); engineering.close()

def self_test():
    need(sha(js_json(TABLE)) == SOURCE['tableSha256'],'table-transcription-hash')
    ids=[f'unit-{i:03}' for i in range(1,31)]
    request=dict(schemaVersion=1,projectId='sample-project',populationId='sample-population',productType='height-control',unitProductType='survey-section',
        definitionEvidenceSha256='1'*64,orderedUnitProductIds=ids,populationHash=frame_hash(ids),stage='acceptance',inspectionMode='table-1-simple-random',round=1,
        randomSource=dict(seedHex='0'*64,sourceDescription='independent-test-seed',receiptSha256='2'*64,trust='caller-declared-not-authenticated'))
    plan=compute_plan(request)
    need(plan['requestHash']=='0ed73999c6a04b70b381d02a1ef66d8737c1c988e461940ea38bd1105dc17f96','request-golden')
    need(plan['planHash']=='095bb4e26f12f6c2274d4ed9cf9c18f35f9facdf3ec6f4d002b852b35a248b57','plan-golden')
    need(plan['batches'][0]['selectedUnitProductIds']==['unit-019','unit-009','unit-030','unit-021','unit-027'],'sample-golden')
    need(plan['batches'][0]['randomTranscriptSha256']=='68283403452db55f47c1201b9dd3a21b754a9351f2879c02c1e8ebcd70946807','transcript-golden')
    for count in [1,2,3,1001,10000]:
        ids=[f'u{i}' for i in range(count)]
        census={**request,'orderedUnitProductIds':ids,'populationHash':frame_hash(ids),'inspectionMode':'census','stage':'final-office'}
        census.pop('randomSource'); result=compute_plan(census)
        need(result['sampleSize']==count and all(b['census'] and b['randomDrawCount']==0 for b in result['batches']),'census-golden')
    for number in [0.1,9007199254740992,float('nan')]:
        try: js_json(number)
        except AuditFailure: pass
        else: raise AuditFailure('unsupported-numbers-accepted')
    return 'passed'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,help='candidate engineering directory containing both SQLite files')
    parser.add_argument('--output',type=Path,help='optional redacted JSON report')
    parser.add_argument('--self-test',action='store_true')
    args=parser.parse_args()
    report={'auditVersion':'sampling-independent-python-1','checkedAt':datetime.now(timezone.utc).isoformat(),
        'implementation':'Python standard library; no product imports',
        'trust':'Local SHA-256/HMAC consistency is not a signature, independent custody, verified randomness or professional approval.',
        'snapshot':'Separate read-only SQLite snapshots; run with GUI idle. Commit detection does not make the two snapshots atomic.'}
    try:
        report['selfTest']=self_test()
        if args.root:
            need(args.root.is_dir(),'engineering-directory-missing')
            if not (args.root/'survey-sampling.sqlite3').is_file(): report.update(status='not-evaluated',reason='sampling-database-missing',populationCount=0,runCount=0)
            else: report.update(audit(args.root))
        else:
            need(args.self_test,'root-or-self-test-required')
            report.update(status='not-evaluated',reason='self-test-only-not-real-candidate-evidence')
    except Exception as error:
        report.update(status='failed',failure=error.args[0] if isinstance(error,AuditFailure) else type(error).__name__)
    output=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
    if args.output: args.output.write_text(output,encoding='utf-8')
    print(output,end='')
    return 1 if report['status']=='failed' else 0

if __name__=='__main__': sys.exit(main())
