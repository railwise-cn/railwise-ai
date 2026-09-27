import assert from 'node:assert/strict';
import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const root = await realpath(process.argv[2]);
const helperRoot = resolve(process.argv[3] || dirname(fileURLToPath(import.meta.url)));
const port = Number(process.argv[4]);
assert(Number.isInteger(port) && port > 0 && port < 65536);
assert.match(root, /^\/private\/tmp\/railwise-survey-[a-zA-Z0-9-]+$/);
const ids = {
  sourceHead: 'fbb88ea715571e9689cbc1c0802da08762e4318d',
  projectId: 'project_50aa4738-da8d-4e87-8fea-7dbbc3f5fd83',
  networkId: 'network_eb2aeea2-84cc-41ed-984d-db84e49fa5a9',
  threadId: 'thr_inslys6a', planId: 'eplan_f9a8c3dc-398a-45d2-aeeb-11d2ba1d7ebe',
  adjustmentId: 'adjustment_23a326c5-4061-4c85-868b-631e4b7f9e60',
  deliveryRunId: 'run_7273285f-2a85-4262-a287-79050785b2b1'
};
const runtime = join(root, 'home/.workwise/runtime');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const read = path => readFile(path, 'utf8');
const readJson = async path => JSON.parse(await read(path));
const inside = async path => {
  const real = await realpath(path), child = relative(root, real);
  assert(child && !child.startsWith('..' + sep) && child !== '..' && !child.startsWith(sep));
  return real;
};
const readJsonl = async path => (await read(await inside(path))).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const databasePaths = ['engineering/engineering-ai.sqlite3', 'engineering/engineering.sqlite3', 'engineering/survey.sqlite3', 'tasks.sqlite3'];
const databaseHashes = async () => {
  const pairs = [];
  for (const path of databasePaths) for (const suffix of ['', '-wal']) {
    const file = join(runtime, path + suffix);
    try { pairs.push([path + suffix, hash(await readFile(await inside(file)))]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; pairs.push([path + suffix, null]); }
  }
  return Object.fromEntries(pairs);
};
const before = await databaseHashes();
const databases = [];
const open = async name => { const db = new DatabaseSync(await inside(join(runtime, name)), { readOnly: true }); databases.push(db); return db; };
const row = (db, table, id) => {
  const result = db.prepare(`SELECT data_json FROM ${table} WHERE id = ?`).get(id);
  assert(result, `Missing scoped record in ${table}`);
  return { text: result.data_json, value: JSON.parse(result.data_json) };
};

try {
  const ai = await open(databasePaths[0]), engineering = await open(databasePaths[1]), survey = await open(databasePaths[2]), tasks = await open(databasePaths[3]);
  const planRecord = row(ai, 'engineering_ai_plans', ids.planId), plan = planRecord.value;
  assert.equal(plan.projectId, ids.projectId); assert.equal(plan.threadId, ids.threadId);
  assert(plan.goal.includes('RAILWISE-SYNTHETIC-ACCEPTANCE'));
  const taskRecord = row(tasks, 'task_runs', plan.taskId), task = taskRecord.value;
  assert.equal(task.threadId, ids.threadId); assert.equal(task.status, 'completed'); assert.equal(task.activeTurnId, plan.executionTurnId);
  assert.equal(task.attempts, 1); assert.equal(task.replans, 0);
  assert(task.nodes.length && task.nodes.every(node => node.status === 'completed'));
  const metadataPath = join(runtime, 'threads', ids.threadId, 'metadata.jsonl');
  const messagesPath = join(runtime, 'threads', ids.threadId, 'messages.jsonl');
  const metadata = (await readJsonl(metadataPath)).findLast(item => item.kind === 'thread_metadata').thread;
  assert.equal(metadata.projectId, ids.projectId); assert.equal(metadata.domain, 'engineering');
  const turn = metadata.turns.find(item => item.id === plan.executionTurnId);
  assert.equal(turn.status, 'completed'); assert.equal(turn.model, 'deepseek-flash');
  assert.equal(turn.toolCatalogToolCount, 5); assert.equal(turn.toolCatalogDrift, false);
  for (const field of ['attachmentIds', 'workspaceReferences', 'activeSkillIds', 'injectedMemoryIds']) assert.deepEqual(turn[field], []);
  const rawItems = await readJsonl(messagesPath);
  const unique = [...new Map(rawItems.map(item => [item.id, item])).values()];
  const execution = unique.filter(item => item.turnId === plan.executionTurnId);
  const calls = execution.filter(item => item.kind === 'tool_call');
  const results = execution.filter(item => item.kind === 'tool_result');
  const expectedTools = ['survey_network_validate', 'control_network', 'survey_adjustment_read', 'report_export'];
  assert.deepEqual(calls.map(item => item.toolName), expectedTools);
  assert.deepEqual(results.map(item => item.toolName), expectedTools);
  assert.deepEqual(plan.steps.map(item => item.tool), expectedTools);
  assert.equal(task.finalResponse, execution.filter(item => item.kind === 'assistant_text').at(-1).text);
  assert(unique.filter(item => item.kind === 'user_message').every(item => item.text.includes('RAILWISE-SYNTHETIC-ACCEPTANCE')));
  const stepEvidence = ai.prepare('SELECT step_id, parameters_json, handles_json FROM engineering_ai_step_evidence WHERE plan_id = ?').all(ids.planId);
  assert.equal(stepEvidence.length, 4);
  const steps = plan.steps.map((step, index) => {
    assert.equal(step.approval, 'approved'); assert.equal(step.inputHash, plan.contextHash);
    const call = calls[index], result = results[index], persisted = stepEvidence.find(item => item.step_id === step.id);
    assert.equal(call.callId, result.callId); assert.equal(call.status, 'completed'); assert.equal(result.isError, false);
    assert.equal(call.threadId, ids.threadId); assert.equal(result.threadId, ids.threadId);
    assert(persisted);
    const parameters = JSON.parse(persisted.parameters_json), handles = JSON.parse(persisted.handles_json);
    assert.equal(parameters.idempotencyKey, `engineering-plan:${ids.planId}:${step.id}`);
    const expected = { ...step.parameters };
    for (const binding of step.parameterBindings) {
      const predecessor = stepEvidence.find(item => item.step_id === binding.stepId);
      const value = JSON.parse(predecessor.handles_json)[binding.output];
      assert.notEqual(value, undefined); expected[binding.parameter] = binding.asArray ? [value] : value;
    }
    expected.idempotencyKey = parameters.idempotencyKey;
    assert.deepEqual(parameters, expected);
    for (const [key, value] of Object.entries(handles)) {
      const actual = key.split('.').reduce((object, part) => object?.[part], result.output);
      assert.deepEqual(actual, value);
    }
    return { stepId: step.id, tool: call.toolName, callId: call.callId, status: call.status, isError: result.isError,
      parameters, handles, persistedArgumentsRedacted: Object.keys(call.arguments).length === 0,
      outputSha256: jsonHash(result.output), parameterRecordSha256: hash(persisted.parameters_json), handleRecordSha256: hash(persisted.handles_json) };
  });
  const network = row(survey, 'survey_networks', ids.networkId).value;
  assert.equal(network.projectId, ids.projectId); assert.equal(network.revision, 2);
  assert.equal(network.sourceFile.sha256, '4281cc7a10673570756867e8c8665f22f82611839bd34c396a5eba9dbb89d9f0');
  for (const [key, value] of Object.entries(results[0].output.network)) {
    if (key === 'pointCount') assert.equal(value, network.knownPoints.length + network.unknownPoints.length);
    else if (key === 'observationCount') assert.equal(value, network.observations.length);
    else if (key !== 'findings') assert.deepEqual(value, network[key]);
  }
  const adjustmentRecord = row(survey, 'survey_adjustments', ids.adjustmentId), adjustment = adjustmentRecord.value;
  assert.equal(adjustment.run.projectId, ids.projectId); assert.equal(adjustment.run.networkId, ids.networkId);
  assert.equal(adjustment.run.status, 'completed'); assert.equal(adjustment.result.validation, 'valid');
  for (const result of results.slice(1, 3)) {
    assert.deepEqual(result.output.run, adjustment.run);
    for (const [key, value] of Object.entries(result.output.result)) {
      const stored = adjustment.result[key];
      assert.deepEqual(value, Array.isArray(stored) ? stored.slice(0, 200) : stored);
    }
  }
  assert.deepEqual(results[1].output, results[2].output);
  const deliveryRecord = row(engineering, 'engineering_runs', ids.deliveryRunId), delivery = deliveryRecord.value;
  assert.equal(delivery.projectId, ids.projectId); assert.equal(delivery.status, 'completed');
  const exported = results[3].output;
  assert.deepEqual(exported.run, delivery); assert.deepEqual(exported.adjustments, [adjustment.result]);
  assert.deepEqual(exported.surveySources.map(item => item.networkId), [ids.networkId]);
  const manifestCount = engineering.prepare('SELECT COUNT(*) AS count FROM engineering_manifests WHERE project_id = ?').get(ids.projectId).count;
  assert.equal(manifestCount, 0);
  const app = (await readdir(join(root, 'Applications'))).find(name => name.endsWith('.app'));
  assert(app);
  const resources = join(root, 'Applications', app, 'Contents/Resources');
  const asarSha256 = hash(await readFile(join(resources, 'app.asar')));
  assert.equal(asarSha256, '15c19b63ea39fe5618e9d02ca8d977b348e6a12a8db5a8e64f56274a244ed96e');
  const packagedRequire = createRequire(join(resources, 'app.asar.unpacked/kun/package.json'));
  const JSZip = packagedRequire('jszip');
  assert.deepEqual(exported.files.map(file => basename(file.path)).sort(), ['evidence.xlsx', 'report.docx', 'report.pdf']);
  const files = [];
  for (const file of exported.files) {
    assert(file.path.startsWith(`.workwise/deliverables/${ids.projectId}/${ids.deliveryRunId}/`));
    const path = await inside(join(metadata.workspace, file.path)), bytes = await readFile(path);
    assert.equal(bytes.length, file.sizeBytes); assert.equal(hash(bytes), file.sha256);
    const name = basename(path);
    let format;
    if (name.endsWith('.pdf')) {
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      const info = execFileSync('pdfinfo', [path], { encoding: 'utf8' });
      const pages = Number(info.match(/^Pages:\s+(\d+)$/m)?.[1]); assert(pages > 0);
      format = { parser: 'pdfinfo', pages, parsed: true };
    } else {
      const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
      const entry = name.endsWith('.docx') ? 'word/document.xml' : 'xl/workbook.xml';
      const types = await zip.file('[Content_Types].xml')?.async('string');
      const xml = await zip.file(entry)?.async('string');
      assert(types && xml);
      assert(types.includes(name.endsWith('.docx') ? 'wordprocessingml.document.main+xml' : 'spreadsheetml.sheet.main+xml'));
      const sheetCount = name.endsWith('.xlsx') ? Object.keys(zip.files).filter(key => /^xl\/worksheets\/sheet\d+\.xml$/.test(key)).length : undefined;
      if (sheetCount !== undefined) assert(sheetCount > 0);
      format = { parser: 'JSZip', crc32Verified: true, requiredContentTypeAndXmlPresent: true, ...(sheetCount ? { sheetCount } : {}) };
    }
    files.push({ ...file, format });
  }
  const reportPath = join(root, 'evidence/relay-report-c5fb2d79918033a7.json'), relay = await readJson(reportPath);
  assert.equal(relay.reason, 'SIGINT'); assert.equal(relay.projectId, ids.projectId); assert.equal(relay.networkId, ids.networkId); assert.equal(relay.threadId, ids.threadId);
  assert.equal(relay.requestCount, 8); assert.equal(relay.upstreamCount, 8);
  assert.equal(relay.events.filter(event => event.kind === 'failed').length, 0);
  const started = relay.events.filter(event => event.kind === 'upstream_started');
  assert.equal(started.filter(event => event.route === 'chat_completions').length, 5);
  assert.equal(started.filter(event => event.route === 'models').length, 3);
  for (const request of started) {
    for (const kind of ['upstream_status', 'completed']) {
      const events = relay.events.filter(event => event.requestId === request.requestId && event.kind === kind);
      assert.equal(events.length, 1); assert.equal(events[0].status, 200);
    }
  }
  await assert.rejects(stat(join(root, 'evidence/relay-local-token-c5fb2d79918033a7.txt')), { code: 'ENOENT' });
  const portClosed = await new Promise((resolveClosed, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Loopback closure check timed out')); });
    socket.once('connect', () => { socket.destroy(); resolveClosed(false); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolveClosed(true) : reject(error));
  });
  assert.equal(portClosed, true);
  const settings = await readJson(join(root, 'user-data/workwise-settings.json'));
  let credentialFieldCount = 0;
  const checkEmptyCredentials = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(apiKey|accessToken|secret)$/i.test(key) && typeof child === 'string') { credentialFieldCount++; assert.equal(child.length, 0, 'Candidate credential field not empty'); }
      else if (child && typeof child === 'object') checkEmptyCredentials(child);
    }
  };
  checkEmptyCredentials(settings); assert(credentialFieldCount >= 4);
  assert.equal(settings.provider.baseUrl, 'https://api.deepseek.com');
  const settingsCredentialFieldCount = credentialFieldCount;
  checkEmptyCredentials(await readJson(join(runtime, 'config.json')));
  const runtimeCredentialFieldCount = credentialFieldCount - settingsCredentialFieldCount;
  assert.deepEqual(await databaseHashes(), before);
  const helperHashes = Object.fromEntries(await Promise.all(['railwise-typed-acceptance-relay.mjs', 'railwise-typed-relay-guard.mjs'].map(async name => [name, hash(await readFile(join(helperRoot, name)))])));
  helperHashes['verify-typed-model-execution.mjs'] = hash(await readFile(fileURLToPath(import.meta.url)));
  console.log(JSON.stringify({ schemaVersion: 1, status: 'passed', checkedAt: new Date().toISOString(), ...ids, asarSha256,
    evidenceType: 'independent read-only audit of real model execution on a synthetic candidate fixture',
    provenance: { preparedPlanFixture: true, modelExecution: 'official provider through temporary loopback relay', model: turn.model, sourceRecords: { planSha256: hash(planRecord.text), taskSha256: hash(taskRecord.text), adjustmentSha256: hash(adjustmentRecord.text), deliveryRunSha256: hash(deliveryRecord.text), messagesJsonlSha256: hash(await readFile(messagesPath)), metadataJsonlSha256: hash(await readFile(metadataPath)), relayReportSha256: hash(await readFile(reportPath)) }, helperHashes },
    execution: { rawPlanStatus: plan.status, planRevision: plan.revision, taskId: task.id, taskStatus: task.status, taskAcceptanceKind: task.acceptance.kind, taskArtifactCardCount: task.artifacts.length, executionTurnId: turn.id, turnStatus: turn.status, attempts: task.attempts, replans: task.replans, allowedToolCount: 5, actualToolCallCount: 4, actualToolResultCount: 4, allStepsApprovedAndBound: true, unauthorizedToolCount: 0, toolOutputsMatchDeterministicRecords: true, finalResponseMatchesTask: true, noAttachmentsOrMemoryInjection: true, steps },
    delivery: { runStatus: delivery.status, manifestCount, formalDeliveryApproved: false, files },
    relay: { startedAt: relay.startedAt, stoppedAt: relay.stoppedAt, reason: relay.reason, chatRequestsHttp200: 5, modelListRequestsHttp200: 3, failedRequests: 0, originalScopeLabel: relay.relayScope, scopeLabelCorrection: 'Five allowed tools, including read-only survey_read_context; four typed measurement tools actually called.' },
    cleanup: { temporaryTokenMissing: true, loopbackPortClosed: true, candidateCredentialFieldsChecked: settingsCredentialFieldCount, candidateCredentialFieldsEmpty: true, runtimeConfigCredentialFieldCount: runtimeCredentialFieldCount, providerBaseUrlRestored: true },
    audit: { readOnlyDatabases: true, databaseAndWalBytesUnchanged: true, newModelRequests: 0 },
    limitations: ['The plan and source data were prepared synthetic fixtures; only the subsequent execution was a real model round-trip.', 'Persisted tool arguments are redacted; exact bound arguments are corroborated by the independent per-step evidence rows.', 'Original provider response streams were not retained. Byte-preserving relay code and successful guard checks support provenance; this audit does not recreate missing wire captures.', 'Task and turn completed; the original plan execution record still says started. No formal manifest or delivery approval exists.', 'This is not direct official credential-chain acceptance, real-project validation, production KPI measurement or release approval.']
  }, null, 2));
} finally { for (const db of databases) db.close(); }
