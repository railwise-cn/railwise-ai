import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import JSZip from 'jszip'

const execute = promisify(execFile)
export const browserSmokeDependency = Object.freeze({
  chromeVersion: '157.0.8103.78',
  extensionVersion: '0.4.0',
  extensionUrl: 'https://github.com/Tencent/BrowserSkill/releases/download/ext-v0.4.0/browser-skill-extension-v0.4.0-chrome.zip',
  extensionSha256: 'ebb28abf4d18e8983e416647145d2acdbd3aa0a3b70320bf39401e27b5d4f16e'
})

export function chromeSmokeAsset(platform, arch) {
  const target = platform === 'win32' && arch === 'x64' ? 'win64' : platform === 'darwin' && ['x64', 'arm64'].includes(arch) ? `mac-${arch}` : undefined
  assert.ok(target, 'Browser acceptance supports the Windows x64 and macOS test hosts')
  return { target, url: `https://storage.googleapis.com/chrome-for-testing-public/${browserSmokeDependency.chromeVersion}/${target}/chrome-${target}.zip`,
    executable: target === 'win64' ? 'chrome-win64/chrome.exe' : `chrome-${target}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` }
}

async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, path, expectedHash) {
  let existing = await stat(path).catch(() => undefined)
  if (!existing?.size || expectedHash && await fileHash(path) !== expectedHash) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) })
    assert.equal(response.ok, true, `Official test dependency returned HTTP ${response.status}`)
    assert.ok(response.body, 'Official test dependency has no response body')
    const temporary = `${path}.partial`
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
      const expectedBytes = Number(response.headers.get('content-length'))
      if (expectedBytes) assert.equal((await stat(temporary)).size, expectedBytes, 'The complete test dependency must be downloaded')
      await rename(temporary, path)
    } catch (error) { await rm(temporary, { force: true }); throw error }
    existing = await stat(path)
  }
  const sha256 = await fileHash(path)
  if (expectedHash) assert.equal(sha256, expectedHash, 'The official BrowserSkill extension digest must match the fixed release')
  return { bytes: existing.size, sha256 }
}

/** Installs only test dependencies under an explicitly owned temporary directory. */
export async function prepareBrowserSkillSmoke(root, { platform = process.platform, arch = process.arch } = {}) {
  assert.ok(isAbsolute(root), 'Use an absolute owned browser acceptance directory')
  const directory = resolve(root)
  await mkdir(directory, { recursive: true })
  const chrome = chromeSmokeAsset(platform, arch)
  const chromeZip = join(directory, `chrome-${chrome.target}-${browserSmokeDependency.chromeVersion}.zip`)
  const extensionZip = join(directory, `browser-skill-extension-${browserSmokeDependency.extensionVersion}.zip`)
  const [chromeArchive, extensionArchive] = await Promise.all([
    download(chrome.url, chromeZip),
    download(browserSmokeDependency.extensionUrl, extensionZip, browserSmokeDependency.extensionSha256)
  ])
  const extension = await JSZip.loadAsync(await readFile(extensionZip))
  const manifests = Object.values(extension.files).filter(file => !file.dir && /(?:^|\/)manifest\.json$/.test(file.name))
  assert.equal(manifests.length, 1, 'Expected one official extension manifest')
  for (const entry of Object.values(extension.files)) {
    const name = entry.unsafeOriginalName ?? entry.name
    assert.ok(!isAbsolute(name) && !name.split(/[\\/]/).includes('..'), 'Extension archive paths must remain in the owned directory')
  }
  const manifest = JSON.parse(await manifests[0].async('string'))
  assert.equal(manifest.version, browserSmokeDependency.extensionVersion)
  assert.equal(manifest.manifest_version, 3)
  const extensionRoot = join(directory, 'extension')
  await mkdir(extensionRoot, { recursive: true })
  await execute('tar', ['-xf', extensionZip, '-C', extensionRoot], { windowsHide: true })
  const chromeRoot = join(directory, 'chrome')
  await mkdir(chromeRoot, { recursive: true })
  const executable = join(chromeRoot, chrome.executable)
  if (!(await stat(executable).catch(() => undefined))) await execute('tar', ['-xf', chromeZip, '-C', chromeRoot], { windowsHide: true, maxBuffer: 1024 * 1024 })
  if (platform !== 'win32') await chmod(executable, 0o755)
  return { executable, extensionDirectory: join(extensionRoot, dirname(manifests[0].name)),
    evidence: { browser: { version: browserSmokeDependency.chromeVersion, source: chrome.url, ...chromeArchive },
      extension: { version: manifest.version, source: browserSmokeDependency.extensionUrl, ...extensionArchive } } }
}

export function launchBrowserSkillSmoke(prepared, profile) {
  assert.ok(isAbsolute(profile), 'Use an owned isolated browser profile')
  const child = spawn(prepared.executable, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--user-data-dir=${profile}`, `--disable-extensions-except=${prepared.extensionDirectory}`, `--load-extension=${prepared.extensionDirectory}`,
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let log = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log = (log + data.toString()).slice(-16000) })
  let launchError
  child.once('error', error => { launchError = error })
  return { child, diagnostics: () => ({ exitCode: child.exitCode, launchError: launchError?.message, log }),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
      if (process.platform === 'win32') await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
      else {
        child.kill('SIGTERM')
        await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 3000))])
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    } }
}
