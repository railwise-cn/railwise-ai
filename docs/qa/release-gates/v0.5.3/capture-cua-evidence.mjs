import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(message) }

export function pngSize(bytes) {
  const data = Buffer.from(bytes)
  if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || data.subarray(12, 16).toString('ascii') !== 'IHDR') fail('Expected an original PNG screenshot')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

export function reviewedWindow(observation, identity, windowId) {
  if (observation.operation !== 'observe-window' || observation.targetPID !== identity.pid) {
    fail('Window observation must belong to the reviewed package PID')
  }
  const window = observation.windows.find(item => item.id === windowId)
  if (!window || window.ownerPID !== identity.pid || window.layer !== 0 || !window.onScreen
    || window.title !== 'RailWise AI' || !window.bounds
    || !(window.bounds.width > 0 && window.bounds.height > 0)) fail('Reviewed window is not a visible RailWise AI main window')
  return window
}

export async function captureCuaEvidence(app, options) {
  const { root, id, identityPath, observationPath, windowId, locale, theme, page,
    requestedWindowLogicalSize, findings = [] } = options
  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(id)) fail('Invalid capture ID')
  if (!['zh', 'en'].includes(locale) || !['light', 'dark', 'system'].includes(theme)) fail('Invalid locale/theme declaration')
  if (!['overview', 'process', 'results', 'deliver', 'state'].includes(page)) fail('Invalid page declaration')
  const identity = JSON.parse(await readFile(identityPath, 'utf8'))
  if (identity.version !== '0.5.3' || identity.bundleId !== 'com.wangjiawei508.workgpt'
    || !/^[a-f0-9]{40}$/.test(identity.sourceHead) || !/^[a-f0-9]{64}$/.test(identity.asarSha256)
    || !Number.isInteger(identity.pid) || identity.pid <= 0 || !identity.appPath?.endsWith('/RailWise AI.app')) fail('Missing observed final package identity')
  const observationBytes = await readFile(observationPath)
  const observation = JSON.parse(observationBytes)
  const window = reviewedWindow(observation, identity, windowId)
  const age = Date.now() - Date.parse(observation.capturedAt)
  if (!Number.isFinite(age) || age < -5_000 || age > 60_000) fail('Window observation is not fresh')
  const capturesRoot = join(resolve(root), 'captures')
  await mkdir(capturesRoot, { recursive: true })
  const folder = join(capturesRoot, id)
  await mkdir(folder, { recursive: false })
  const captured = await app.getAXStateAndScreenshot({ disableDiffing: true, emit: false })
  if (!captured.state || !captured.screenshot) fail('Computer-use capture did not return AX and screenshot')
  const screenshot = Buffer.from(captured.screenshot)
  const pixels = pngSize(screenshot)
  const actual = { width: window.bounds.width, height: window.bounds.height }
  const matches = requestedWindowLogicalSize
    ? actual.width === requestedWindowLogicalSize.width && actual.height === requestedWindowLogicalSize.height
    : null
  const record = {
    schemaVersion: 1, type: 'Observed CUA evidence; not an automatic acceptance conclusion',
    capturedAt: new Date().toISOString(), id, locale, theme, page,
    packageIdentity: identity, windowId, requestedWindowLogicalSize: requestedWindowLogicalSize ?? null,
    actualWindowLogicalSize: actual, actualScreenshotPixelSize: pixels, requestedSizeMatches: matches,
    observationCapturedAt: observation.capturedAt,
    screenshot: 'screenshot.png', ax: 'ax.txt', windowObservation: 'window.json',
    sha256: { screenshot: sha256(screenshot), ax: sha256(Buffer.from(captured.state)), windowObservation: sha256(observationBytes) },
    status: 'observed-not-reviewed', findings
  }
  await writeFile(join(folder, 'screenshot.png'), screenshot, { flag: 'wx' })
  await writeFile(join(folder, 'ax.txt'), captured.state, { flag: 'wx' })
  await writeFile(join(folder, 'window.json'), observationBytes, { flag: 'wx' })
  await writeFile(join(folder, 'capture.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  return { folder, record }
}
