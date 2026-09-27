import http from 'node:http';
import { createGuard, candidateEvidenceLoader } from './railwise-typed-relay-guard.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, unlink, stat, realpath } from 'node:fs/promises';
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const UPSTREAM = 'https://api.deepseek.com';
const MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash']);
const MAX_BODY = 262144;

function deny(status, code) {
  return Object.assign(new Error(code), { publicStatus: status, publicCode: code });
}

export async function loadSettingsKey(settingsPath) {
  const info = await stat(settingsPath);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('credential_source_invalid');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const key = settings?.provider?.apiKey;
  if (typeof key !== 'string' || !key.trim()) throw new Error('credential_unavailable');
  return key.trim();
}

// fetchImpl/keyLoader are test seams. The CLI has no upstream override.
export async function startRelay({ outputDir, settingsPath, projectId, networkId, threadId, candidateRoot, evidenceLoader,
  model = 'deepseek-flash',
  maxRequests = 8, durationMs = 180000, requestTimeoutMs = 60000,
  fetchImpl = globalThis.fetch, keyLoader = () => loadSettingsKey(settingsPath), onEvent = () => {} }) {
  if (!isAbsolute(outputDir) || !MODELS.has(model) || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 20 ||
      !Number.isFinite(durationMs) || durationMs < 1 || durationMs > 600000 ||
      !Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 90000) {
    throw new Error('invalid_relay_configuration');
  }
  const loadEvidence = evidenceLoader ?? candidateEvidenceLoader({ candidateRoot, projectId, networkId, threadId });
  await loadEvidence();
  if (!evidenceLoader) {
    const child = relative(await realpath(candidateRoot), await realpath(outputDir));
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('output_must_be_inside_candidate');
  }
  const guard = createGuard({ candidateRoot, projectId, networkId, threadId, evidenceLoader: loadEvidence });
  const token = randomBytes(32).toString('base64url');
  const session = randomBytes(8).toString('hex');
  const tokenPath = resolve(outputDir, `relay-local-token-${session}.txt`);
  const reportPath = resolve(outputDir, `relay-report-${session}.json`);
  await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 });
  const events = [];
  const controllers = new Set();
  const pending = new Set();
  let requestCount = 0;
  let upstreamCount = 0;
  let keyPromise;
  let stopPromise;
  let timer;
  let port;
  const startedAt = new Date().toISOString();
  const emit = (event) => {
    const safe = { at: new Date().toISOString(), ...event };
    events.push(safe);
    onEvent(safe);
  };
  const server = http.createServer(async (req, res) => {
    let markDone;
    const done = new Promise((resolveDone) => { markDone = resolveDone; });
    pending.add(done);
    const requestId = ++requestCount;
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const onClose = () => { if (!res.writableFinished) controller.abort(); };
    res.on('close', onClose);
    controller.signal.addEventListener('abort', () => {
      if (!res.writableFinished) res.destroy();
    }, { once: true });
    let accepted = false;
    let status = 0;
    try {
      if (requestCount > maxRequests || stopPromise) throw deny(429, 'request_budget_exhausted');
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin) {
        throw deny(403, 'local_client_required');
      }
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw deny(401, 'unauthorized');
      const isModels = req.method === 'GET' && req.url === '/v1/models';
      const isChat = req.method === 'POST' && req.url === '/v1/chat/completions';
      if (!isModels && !isChat) throw deny(403, 'route_not_allowed');
      if (isModels && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0)) {
        throw deny(400, 'unexpected_body');
      }
      let body;
      if (isChat) {
        if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') throw deny(415, 'json_required');
        if (Number(req.headers['content-length'] || 0) > MAX_BODY) throw deny(413, 'body_too_large');
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > MAX_BODY) throw deny(413, 'body_too_large');
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
        await guard.validateRequest(body, model);
      }
      if (controller.signal.aborted) throw deny(504, 'request_timeout');
      keyPromise ??= Promise.resolve().then(keyLoader);
      const key = await keyPromise;
      if (typeof key !== 'string' || !key.trim()) throw deny(503, 'credential_unavailable');
      accepted = true;
      upstreamCount += 1;
      emit({ requestId, kind: 'upstream_started', route: isChat ? 'chat_completions' : 'models', model: isChat ? model : null });
      let upstream = await fetchImpl(`${UPSTREAM}${isChat ? '/v1/chat/completions' : '/v1/models'}`, {
        method: isChat ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, Accept: isChat ? 'application/json, text/event-stream' : 'application/json',
          ...(isChat ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {})
      });
      status = upstream.status;
      emit({ requestId, kind: 'upstream_status', status });
      if (status < 200 || status >= 300) {
        await upstream.body?.cancel();
        throw deny(status >= 400 && status <= 599 ? status : 502, 'upstream_rejected');
      }
      const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
      if (!/^(application\/json|text\/event-stream)(;|$)/i.test(contentType)) {
        await upstream.body?.cancel();
        throw deny(502, 'upstream_content_type');
      }
      // Buffer the official bytes until every emitted tool call has passed scope checks.
      // No response text or tool result is generated or rewritten by this relay.
      if (isChat) {
        const reader = upstream.body?.getReader();
        if (!reader) throw deny(502, 'empty_upstream_response');
        const abortReader = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', abortReader, { once: true });
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (controller.signal.aborted) throw deny(499, 'client_cancelled');
            bytes += chunk.value.byteLength;
            if (bytes > 8 * 1024 * 1024) throw deny(502, 'response_too_large');
            chunks.push(Buffer.from(chunk.value));
          }
          if (controller.signal.aborted) throw deny(499, 'client_cancelled');
          const validatedBytes = Buffer.concat(chunks);
          try { guard.validateResponse(validatedBytes, contentType); }
          catch (error) { throw deny(502, error?.publicCode ?? 'upstream_tool_scope_rejected'); }
          upstream = new Response(validatedBytes, { status, headers: { 'Content-Type': contentType } });
        } finally {
          controller.signal.removeEventListener('abort', abortReader);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const abortReader = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', abortReader, { once: true });
        let responseBytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (controller.signal.aborted) throw deny(499, 'client_cancelled');
            responseBytes += value.byteLength;
            if (responseBytes > 8 * 1024 * 1024) throw deny(502, 'response_too_large');
            if (!res.write(value)) {
              await new Promise((resolveDrain, rejectDrain) => {
                const cleanup = () => { res.off('drain', onDrain); res.off('close', onAbort); };
                const onDrain = () => { cleanup(); resolveDrain(); };
                const onAbort = () => { cleanup(); rejectDrain(deny(499, 'client_cancelled')); };
                res.once('drain', onDrain);
                res.once('close', onAbort);
              });
            }
          }
          if (controller.signal.aborted) throw deny(499, 'client_cancelled');
          await new Promise((finished, failed) => {
            const closed = () => { res.off('finish', onFinished); failed(deny(499, 'client_cancelled')); };
            const onFinished = () => { res.off('close', closed); finished(); };
            res.once('finish', onFinished);
            res.once('close', closed);
            res.end();
          });
        } finally {
          controller.signal.removeEventListener('abort', abortReader);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } else res.end();
      emit({ requestId, kind: 'completed', status, model: isChat ? model : null });
    } catch (error) {
      const code = error?.publicCode ?? (controller.signal.aborted ? 'cancelled_or_timeout' : 'relay_failed');
      emit({ requestId, kind: 'failed', status: error?.publicStatus ?? 502, code, upstreamRequested: accepted });
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(error?.publicStatus >= 400 && error.publicStatus <= 599 ? error.publicStatus : 502,
          { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: code }));
      } else if (!res.writableEnded) res.destroy();
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
      res.off('close', onClose);
      pending.delete(done);
      markDone();
      if (requestCount >= maxRequests) setImmediate(() => stop('request_budget'));
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = requestTimeoutMs;
  server.maxHeadersCount = 30;
  server.maxConnections = 4;
  async function stop(reason = 'operator') {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      clearTimeout(timer);
      for (const controller of controllers) controller.abort();
      await new Promise((done) => { server.close(done); server.closeAllConnections(); });
      await Promise.allSettled([...pending]);
      keyPromise = undefined;
      await unlink(tokenPath).catch(() => {});
      const report = { startedAt, stoppedAt: new Date().toISOString(), reason, model, requestCount, upstreamCount, projectId, networkId, threadId,
        relayScope: 'four typed measurement tools; persisted synthetic thread results; buffered original upstream bytes',
        candidateCredentialAccess: 'unchanged; require 0', officialCredentialStoredInCandidate: false,
        acceptanceScope: 'GUI via loopback relay to official provider; not direct official credential-chain acceptance', events };
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      onEvent({ kind: 'stopped', reason, requestCount, upstreamCount, reportPath });
      return report;
    })();
    return stopPromise;
  }
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    port = server.address().port;
  } catch (error) { await unlink(tokenPath).catch(() => {}); throw error; }
  timer = setTimeout(() => { void stop('duration_budget'); }, durationMs);
  return { origin: `http://127.0.0.1:${port}`, tokenPath, reportPath, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--settings-path', '--output-dir', '--model', '--max-requests', '--duration-seconds', '--candidate-root', '--project-id', '--network-id', '--thread-id'].includes(args[i]) ||
        !args[i + 1] || values[args[i]] !== undefined) throw new Error('invalid_arguments');
    values[args[i]] = args[i + 1];
  }
  if (!isAbsolute(values['--settings-path'] ?? '') || !isAbsolute(values['--output-dir'] ?? '')) {
    throw new Error('absolute_settings_path_and_output_dir_required');
  }
  try {
    const relay = await startRelay({ settingsPath: values['--settings-path'], outputDir: values['--output-dir'],
      candidateRoot: values['--candidate-root'], projectId: values['--project-id'], networkId: values['--network-id'], threadId: values['--thread-id'],
      model: values['--model'] ?? 'deepseek-flash', maxRequests: Number(values['--max-requests'] ?? 20),
      durationMs: Number(values['--duration-seconds'] ?? 600) * 1000,
      onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) });
    process.stdout.write(`${JSON.stringify({ kind: 'ready', origin: relay.origin, tokenPath: relay.tokenPath,
      reportPath: relay.reportPath, realCredentialLoaded: false })}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.stop(signal); });
  } catch {
    process.stderr.write('Relay could not start; no credential details logged.\n');
    process.exitCode = 1;
  }
}
