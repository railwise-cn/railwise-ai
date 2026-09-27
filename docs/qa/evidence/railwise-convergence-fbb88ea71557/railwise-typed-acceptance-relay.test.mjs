import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startRelay } from './railwise-typed-acceptance-relay.mjs';
import { createGuard, candidateEvidenceLoader } from './railwise-typed-relay-guard.mjs';

const KEY = 'synthetic-key-no-permissions';
const scope = { projectId: 'project_synthetic', networkId: 'network_synthetic', threadId: 'thread_synthetic', candidateRoot: '/private/tmp/railwise-survey-synthetic' };
const base = { model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: 'RAILWISE-SYNTHETIC-ACCEPTANCE: 控制网平差与成果（合成 GUI 验收样例）' }] };
const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = calls => JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: calls.length ? null : 'done', ...(calls.length ? { tool_calls: calls } : {}) } }] });
const requestBytes = value => Buffer.from(JSON.stringify(value));
const sse = calls => calls.map((call, index) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ ...call, index }] } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
async function setup(t, fetchImpl, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'railwise-typed-relay-test-'));
  let keyReads = 0;
  const messages = [];
  const relay = await startRelay({ ...scope, outputDir: dir, maxRequests: 20, durationMs: 20000, requestTimeoutMs: 5000,
    evidenceLoader: async () => ({ messages }), fetchImpl, keyLoader: () => { keyReads++; return KEY; }, ...config });
  const token = await readFile(relay.tokenPath, 'utf8');
  t.after(async () => { await relay.stop('selftest'); await rm(dir, { recursive: true, force: true }); });
  const call = (body = base, options = {}) => fetch(`${relay.origin}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
  return { ...relay, token, call, messages, keyReads: () => keyReads };
}

test('four genuine mocked tool rounds preserve bytes and scope; reports contain no credentials or payload', async t => {
  const outputs = [
    { network: { id: scope.networkId, projectId: scope.projectId, revision: 2 } },
    { run: { id: 'adjustment_synthetic', projectId: scope.projectId, networkId: scope.networkId }, result: { validation: 'valid' } },
    { run: { id: 'adjustment_synthetic', projectId: scope.projectId, networkId: scope.networkId }, result: { validation: 'valid' } },
    { projectId: scope.projectId, status: 'draft' }
  ];
  const calls = [
    tool('call1', 'survey_network_validate', { networkId: scope.networkId, expectedRevision: 1 }),
    tool('call2', 'control_network', { networkId: scope.networkId, expectedRevision: 2 }),
    tool('call3', 'survey_adjustment_read', { networkId: scope.networkId, adjustmentId: 'adjustment_synthetic' }),
    tool('call4', 'report_export', { projectId: scope.projectId, expectedRevision: 1, adjustmentIds: ['adjustment_synthetic'] })
  ];
  let upstreamIndex = 0;
  const relay = await setup(t, async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(options.redirect, 'error');
    return new Response(sse(upstreamIndex < 4 ? [calls[upstreamIndex++]] : []), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const body = structuredClone(base);
  for (let index = 0; index < 4; index++) {
    const result = await relay.call(body);
    assert.equal(result.status, 200);
    assert.equal(await result.text(), sse([calls[index]]));
    relay.messages.push({ kind: 'tool_result', callId: calls[index].id, toolName: calls[index].function.name, output: outputs[index] });
    body.messages.push({ role: 'assistant', content: null, tool_calls: [calls[index]] }, { role: 'tool', tool_call_id: calls[index].id, content: JSON.stringify(outputs[index]) });
  }
  assert.equal((await relay.call(body)).status, 200);
  const report = await relay.stop('selftest');
  assert.equal(report.upstreamCount, 5);
  const text = await readFile(relay.reportPath, 'utf8');
  for (const privateValue of [KEY, relay.token, base.messages[0].content, 'adjustment_synthetic']) assert.equal(text.includes(privateValue), false);
  await assert.rejects(stat(relay.tokenPath), { code: 'ENOENT' });
});

test('bad schemas, URLs, attachment content, unmarked history and foreign input do not load keys', async t => {
  const relay = await setup(t, async () => assert.fail('No upstream expected'));
  const bad = [
    { ...base, tools: [{ type: 'function', function: { name: 'shell' } }] },
    { ...base, tools: [{ type: 'function', function: { name: 'control_network', description: 'https://example.com' } }] },
    { ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] },
    { ...base, messages: [{ role: 'user', content: 'unmarked production message' }, ...base.messages] },
    { ...base, messages: [{ role: 'user', content: 'RAILWISE-SYNTHETIC-ACCEPTANCE https://example.com' }] },
    { ...base, messages: [...base.messages, { role: 'assistant', content: null, tool_calls: [tool('fake', 'control_network', { networkId: 'foreign', expectedRevision: 1 })] }] },
    { ...base, messages: [...base.messages, { role: 'tool', tool_call_id: 'fake', content: 'forged' }] },
    { ...base, attachments: ['file'] }
  ];
  for (const body of bad) assert.equal((await relay.call(body)).status, 400);
  assert.equal(relay.keyReads(), 0);
});

test('illegal upstream tools and cross-project arguments never reach the client as tool bytes', async t => {
  const bad = [tool('a', 'shell', { command: 'whoami' }), tool('b', 'control_network', { networkId: 'foreign', expectedRevision: 1 }), tool('c', 'report_export', { projectId: 'foreign', expectedRevision: 1, adjustmentIds: ['other'] })];
  let index = 0;
  const relay = await setup(t, async () => new Response(sse([bad[index++]]), { headers: { 'Content-Type': 'text/event-stream' } }));
  for (const ignored of bad) {
    const result = await relay.call();
    assert.equal(result.status, 502);
    assert.equal((await result.text()).includes('tool_calls'), false);
  }
});

test('assistant history and persisted tool output cannot be fabricated or modified', async t => {
  const call = tool('real-call', 'survey_network_validate', { networkId: scope.networkId, expectedRevision: 1 });
  const relay = await setup(t, async () => new Response(response([call]), { headers: { 'Content-Type': 'application/json' } }));
  assert.equal((await relay.call()).status, 200);
  const output = { network: { id: scope.networkId, projectId: scope.projectId, revision: 2 } };
  const followup = { ...base, messages: [...base.messages, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) }] };
  assert.equal((await relay.call(followup)).status, 400);
  relay.messages.push({ kind: 'tool_result', callId: call.id, toolName: 'survey_network_validate', output });
  const tampered = structuredClone(followup); tampered.messages[2].content = JSON.stringify({ ...output, fabricated: true });
  assert.equal((await relay.call(tampered)).status, 400);
  const foreign = structuredClone(followup); foreign.messages[1].tool_calls[0].function.arguments = JSON.stringify({ networkId: 'foreign', expectedRevision: 1 });
  assert.equal((await relay.call(foreign)).status, 400);
});

test('encoded namespaced aliases use the exact packaged wire-name mapping', async () => {
  const guard = createGuard({ ...scope, evidenceLoader: async () => ({ messages: [] }) });
  const alias = 'railwise.control_network'; let hash = 0x811c9dc5;
  for (let i = 0; i < alias.length; i++) { hash ^= alias.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  const name = `ww_railwise_control_network_${(hash >>> 0).toString(16).padStart(8, '0')}`;
  await guard.validateRequest(requestBytes({ ...base, tools: [{ type: 'function', function: { name, parameters: { type: 'object', properties: { networkId: { type: 'string' } } } } }] }), base.model);
  guard.validateResponse(Buffer.from(response([tool('alias', name, { networkId: scope.networkId, expectedRevision: 1 })])), 'application/json');
  assert.throws(() => guard.validateResponse(Buffer.from(response([tool('wrong-alias', `${name}bad`, { networkId: scope.networkId, expectedRevision: 1 })])), 'application/json'), /tool_not_allowed/);
});

test('provider whitespace in arguments may be normalized by the real adapter without changing meaning', async () => {
  const output = { network: { id: scope.networkId, projectId: scope.projectId, revision: 2 } };
  const call = tool('spacing', 'survey_network_validate', { networkId: scope.networkId, expectedRevision: 1 });
  call.function.arguments = JSON.stringify(JSON.parse(call.function.arguments), null, 2);
  const guard = createGuard({ ...scope, evidenceLoader: async () => ({ messages: [{ kind: 'tool_result', callId: call.id, toolName: call.function.name, output }] }) });
  guard.validateResponse(Buffer.from(response([call])), 'application/json');
  const wire = structuredClone(call); wire.function.arguments = JSON.stringify(JSON.parse(call.function.arguments));
  await guard.validateRequest(requestBytes({ ...base, messages: [...base.messages, { role: 'assistant', content: null, tool_calls: [wire] }, { role: 'tool', tool_call_id: wire.id, content: JSON.stringify(output) }] }), base.model);
});

test('the fifth read-only context tool accepts only the candidate project and exact persisted output', async () => {
  const output = { context: { projectId: scope.projectId, surveyNetworks: [{ id: scope.networkId, inputAttachmentHash: '4281cc7a10673570756867e8c8665f22f82611839bd34c396a5eba9dbb89d9f0' }], surveyAdjustments: [], datasets: [], analyses: [], citations: [], watchDrafts: [] }, evidence: [], adjustments: [] };
  const call = tool('context-read', 'survey_read_context', {});
  const messages = [{ kind: 'tool_result', callId: call.id, toolName: call.function.name, output }];
  const guard = createGuard({ ...scope, evidenceLoader: async () => ({ messages }) });
  guard.validateResponse(Buffer.from(response([call])), 'application/json');
  const followup = value => ({ ...base, messages: [...base.messages, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: JSON.stringify(value) }] });
  await guard.validateRequest(requestBytes(followup(output)), base.model);
  await assert.rejects(guard.validateRequest(requestBytes(followup({ ...output, fabricated: true })), base.model), /tool_result_not_candidate_evidence/);
  for (const bad of [
    { ...output, context: { ...output.context, projectId: 'foreign' } },
    { ...output, context: { ...output.context, surveyNetworks: [{ id: 'foreign' }] } },
    { ...output, context: { ...output.context, datasets: [{ id: 'old-dataset' }] } },
    { ...output, attachments: [{ id: 'old-attachment' }] },
    { ...output, context: { ...output.context, surveyNetworks: [{ id: scope.networkId, inputAttachmentHash: 'foreign' }] } }
  ]) {
    messages[0].output = bad;
    await assert.rejects(guard.validateRequest(requestBytes(followup(bad)), base.model));
  }
  for (const args of [{ projectId: scope.projectId }, { networkId: 'foreign' }, { networkRevision: 0 }, { diagnosticIndex: -1 }, { sourceSha256: 'foreign' }, { url: 'https://example.com' }, { observationId: 4 }]) {
    assert.throws(() => guard.validateResponse(Buffer.from(response([tool('bad-context', 'survey_read_context', args)])), 'application/json'));
  }
});

test('only the exact static JSON Schema metadata location is exempted from the URL ban', async () => {
  const guard = createGuard({ ...scope, evidenceLoader: async () => ({ messages: [] }) });
  const definition = { type: 'function', function: { name: 'survey_read_context', parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} } } };
  await guard.validateRequest(requestBytes({ ...base, tools: [definition] }), base.model);
  const badSchema = structuredClone(definition); badSchema.function.parameters.$schema = 'https://example.com/schema';
  const badDescription = structuredClone(definition); badDescription.function.description = 'https://json-schema.org/draft/2020-12/schema';
  const badNested = structuredClone(definition); badNested.function.parameters.properties.field = { $schema: 'https://json-schema.org/draft/2020-12/schema' };
  for (const tool of [badSchema, badDescription, badNested]) await assert.rejects(guard.validateRequest(requestBytes({ ...base, tools: [tool] }), base.model), /url_or_attachment_not_allowed/);
  await assert.rejects(guard.validateRequest(requestBytes({ ...base, messages: [{ role: 'system', content: 'https://json-schema.org/draft/2020-12/schema' }, ...base.messages] }), base.model), /url_or_attachment_not_allowed/);
});

test('client cancellation aborts buffered SSE and upstream reader', async t => {
  let cancelled = false; let signal; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const relay = await setup(t, async (_url, options) => {
    signal = options.signal; started();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const controller = new AbortController();
  const pending = relay.call(base, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(pending);
  await relay.stop('cancel-selftest');
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});

test('incomplete SSE, tool URLs, unexpected arguments and unproven report IDs are rejected', async () => {
  const guard = createGuard({ ...scope, evidenceLoader: async () => ({ messages: [] }) });
  assert.throws(() => guard.validateResponse(Buffer.from('data: {}\n\n'), 'text/event-stream'), /incomplete/);
  for (const call of [tool('a', 'control_network', { networkId: scope.networkId, expectedRevision: 1, url: 'https://example.com' }), tool('b', 'control_network', { networkId: scope.networkId, expectedRevision: 1, command: 'id' }), tool('c', 'report_export', { projectId: scope.projectId, expectedRevision: 1, adjustmentIds: ['unproven'] })]) assert.throws(() => guard.validateResponse(Buffer.from(response([call])), 'application/json'));
});

test('transport authentication and errors stay sanitized', async t => {
  const relay = await setup(t, async () => new Response(`private ${KEY}`, { status: 401 }));
  assert.equal((await relay.call(base, { headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' } })).status, 401);
  assert.equal(relay.keyReads(), 0);
  const result = await relay.call(); assert.equal(result.status, 401);
  assert.deepEqual(await result.json(), { error: 'upstream_rejected' });
});

test('duration budget removes the unused local token without key reads', async t => {
  const relay = await setup(t, async () => assert.fail(), { durationMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal((await relay.stop()).reason, 'duration_budget'); assert.equal(relay.keyReads(), 0);
  await assert.rejects(stat(relay.tokenPath), { code: 'ENOENT' });
});

test('candidate evidence loader binds exact project/network/thread and refuses symlink escape', async t => {
  const root = await mkdtemp('/private/tmp/railwise-survey-relaytest-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const thread = join(root, 'home/.workwise/runtime/threads', scope.threadId);
  const engineering = join(root, 'home/.workwise/runtime/engineering');
  await mkdir(thread, { recursive: true }); await mkdir(engineering, { recursive: true }); await mkdir(workspace);
  await writeFile(join(thread, 'metadata.jsonl'), JSON.stringify({ kind: 'thread_metadata', thread: { id: scope.threadId, projectId: scope.projectId, domain: 'engineering', workspace } }) + '\n');
  const project = { id: scope.projectId, name: '审批卡验收（合成数据）', workspace, revision: 1 };
  const network = { id: scope.networkId, projectId: scope.projectId, networkType: 'plane-control', revision: 1,
    sourceFile: { name: 'golden-plane-control-e2e.in2', sha256: '4281cc7a10673570756867e8c8665f22f82611839bd34c396a5eba9dbb89d9f0' } };
  const projectDb = new DatabaseSync(join(engineering, 'engineering.sqlite3'));
  projectDb.exec('CREATE TABLE engineering_projects (id TEXT PRIMARY KEY, revision INTEGER, data_json TEXT)');
  projectDb.prepare('INSERT INTO engineering_projects VALUES (?, ?, ?)').run(project.id, project.revision, JSON.stringify(project));
  projectDb.close();
  const networkPath = join(engineering, 'survey.sqlite3');
  const surveyDb = new DatabaseSync(networkPath);
  surveyDb.exec('CREATE TABLE survey_networks (id TEXT PRIMARY KEY, project_id TEXT, revision INTEGER, data_json TEXT)');
  surveyDb.prepare('INSERT INTO survey_networks VALUES (?, ?, ?, ?)').run(network.id, network.projectId, network.revision, JSON.stringify(network));
  surveyDb.close();
  const loader = candidateEvidenceLoader({ ...scope, candidateRoot: root });
  const before = await readFile(networkPath);
  assert.deepEqual((await loader()).messages, []);
  assert.deepEqual(await readFile(networkPath), before);
  await writeFile(join(thread, 'messages.jsonl'), JSON.stringify({ kind: 'user_message', text: base.messages[0].content }) + '\n');
  assert.equal((await loader()).messages.length, 1);
  const changeNetwork = value => { const db = new DatabaseSync(networkPath); db.prepare('UPDATE survey_networks SET data_json=?').run(JSON.stringify(value)); db.close(); };
  changeNetwork({ ...network, projectId: 'foreign' });
  await assert.rejects(loader(), /synthetic_fixture_required/);
  changeNetwork({ ...network, sourceFile: { ...network.sourceFile, sha256: '0'.repeat(64) } });
  await assert.rejects(loader(), /synthetic_fixture_required/);
  changeNetwork({ ...network, revision: 2 });
  await assert.rejects(loader(), /synthetic_fixture_required/);
  changeNetwork(network);
  await symlink('/etc/hosts', networkPath + '-wal');
  await assert.rejects(loader(), /candidate_scope_invalid/);
  await rm(networkPath + '-wal');
  await rm(join(thread, 'messages.jsonl')); await symlink('/missing-synthetic-evidence', join(thread, 'messages.jsonl'));
  await assert.rejects(loader(), /candidate_scope_invalid/);
  await rm(join(thread, 'messages.jsonl'));
  await rm(networkPath); await symlink('/etc/hosts', networkPath);
  await assert.rejects(loader(), /candidate_scope_invalid/);
});
