import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import type { MarketplacePackageV1, PypiPackageSourceV1 } from '../../shared/marketplace'
import { readBoundedResponseBuffer } from './bounded-response'
import { isCanonicalPathContained } from './canonical-containment'
import {
  ManagedUvRuntimeService,
  type ManagedUvRuntimeV1
} from './managed-uv-runtime-service'
import { systemFetch } from './system-network'

const execFileAsync = promisify(execFile)
const MAX_PYPI_METADATA_BYTES = 2 * 1024 * 1024
const MAX_WHEEL_BYTES = 64 * 1024 * 1024
const MAX_LOCK_BYTES = 8 * 1024 * 1024
const MAX_LICENSE_BYTES = 2 * 1024 * 1024
const MAX_LICENSE_METADATA_BYTES = 3 * 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/i
const PACKAGE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/
const VERSION = /^[A-Za-z0-9](?:[A-Za-z0-9._+!-]{0,126}[A-Za-z0-9])?$/

type CommandResult = { stdout: string; stderr?: string }
type CommandRunner = (
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<CommandResult>

type ManagedRuntimeProvider = { ensure(): Promise<ManagedUvRuntimeV1> }

export type PypiPackageMaterializerOptions = {
  runtime?: ManagedRuntimeProvider
  fetch?: typeof fetch
  run?: CommandRunner
}

type PypiArtifact = {
  filename: string
  url: string
  sha256: string
  size: number
  uploadedAt: string
}

type PypiMetadata = {
  info?: { name?: unknown; version?: unknown }
  urls?: Array<{
    filename?: unknown
    url?: unknown
    packagetype?: unknown
    yanked?: unknown
    size?: unknown
    upload_time_iso_8601?: unknown
    digests?: { sha256?: unknown }
  }>
}

type PythonRuntimeInspection = {
  name: string
  version: string
  entrypoints: string[]
}

const PYTHON_INSPECTION = [
  'import importlib.metadata as m, json, sys',
  'd=m.distribution(sys.argv[1])',
  'print(json.dumps({"name":d.metadata["Name"],"version":d.version,"entrypoints":sorted(e.name for e in d.entry_points if e.group=="console_scripts")}))'
].join(';')
const PYTHON_SITE_PACKAGES = 'import sysconfig; print(sysconfig.get_path("purelib"))'

const PYTHON_LAUNCHER = `from importlib.metadata import distribution
import sys

site_packages, package_name, executable = sys.argv[1:4]
sys.path.insert(0, site_packages)
entry = next((item for item in distribution(package_name).entry_points if item.group == "console_scripts" and item.name == executable), None)
if entry is None:
    raise SystemExit("RailWise AI Python entry point is unavailable: " + executable)
sys.argv = [executable, *sys.argv[4:]]
result = entry.load()()
raise SystemExit(result if isinstance(result, int) else 0)
`

function normalizePackageName(value: string): string {
  return value.trim().toLowerCase().replace(/[-_.]+/g, '-')
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertHttpsHost(value: string, host: string, label: string): URL {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.username || parsed.password) {
    throw new Error(`${label} must use the trusted ${host} HTTPS origin.`)
  }
  return parsed
}

async function defaultRun(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<CommandResult> {
  const result = await execFileAsync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeoutMs ?? 15 * 60_000,
    windowsHide: true
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

function pypiSource(item: MarketplacePackageV1): PypiPackageSourceV1 {
  const source = item.source
  if (source.kind !== 'pypi' || source.digest.algorithm !== 'sha256' ||
      !PACKAGE_NAME.test(source.packageName) || !VERSION.test(source.version) ||
      source.resolvedRef !== source.version || !SHA256.test(source.digest.value)) {
    throw new Error('Catalog PyPI package metadata is incomplete or mutable.')
  }
  const runtimes = item.components
    .map((component) => component.runtime)
    .filter((runtime) => runtime.kind === 'uv')
  if (runtimes.length === 0 || runtimes.some((runtime) =>
    runtime.packageName !== source.packageName || runtime.version !== source.version ||
    runtime.install.digest.algorithm !== 'sha256' ||
    runtime.install.digest.value.toLowerCase() !== source.digest.value.toLowerCase()
  )) {
    throw new Error('Catalog PyPI runtime does not match its verified component source.')
  }
  return source
}

async function resolveArtifact(
  source: PypiPackageSourceV1,
  fetchImpl: typeof fetch
): Promise<PypiArtifact> {
  const metadataUrl = `https://pypi.org/pypi/${encodeURIComponent(source.packageName)}/${encodeURIComponent(source.version)}/json`
  const response = await fetchImpl(metadataUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'RailWise AI' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`PyPI metadata request failed (${response.status}).`)
  const metadata = JSON.parse((await readBoundedResponseBuffer(response, MAX_PYPI_METADATA_BYTES, 'PyPI metadata')).toString('utf8')) as PypiMetadata
  if (typeof metadata.info?.name !== 'string' ||
      normalizePackageName(metadata.info.name) !== normalizePackageName(source.packageName) ||
      metadata.info.version !== source.version || !Array.isArray(metadata.urls) || metadata.urls.length > 256) {
    throw new Error('PyPI metadata does not match the trusted catalog package.')
  }
  const expected = source.digest.value.toLowerCase()
  const artifact = metadata.urls.find((candidate) =>
    candidate.packagetype === 'bdist_wheel' && candidate.yanked !== true &&
    typeof candidate.digests?.sha256 === 'string' && candidate.digests.sha256.toLowerCase() === expected
  )
  if (!artifact || typeof artifact.filename !== 'string' || !artifact.filename.endsWith('.whl') ||
      basename(artifact.filename) !== artifact.filename || typeof artifact.url !== 'string' ||
      typeof artifact.size !== 'number' || !Number.isSafeInteger(artifact.size) || artifact.size < 1 ||
      artifact.size > MAX_WHEEL_BYTES || typeof artifact.upload_time_iso_8601 !== 'string' ||
      !Number.isFinite(Date.parse(artifact.upload_time_iso_8601))) {
    throw new Error('PyPI does not expose the catalog-pinned wheel artifact.')
  }
  assertHttpsHost(artifact.url, 'files.pythonhosted.org', 'PyPI wheel URL')
  return {
    filename: artifact.filename,
    url: artifact.url,
    sha256: expected,
    size: artifact.size,
    uploadedAt: new Date(artifact.upload_time_iso_8601).toISOString()
  }
}

async function downloadWheel(artifact: PypiArtifact, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(artifact.url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'RailWise AI' },
    redirect: 'follow',
    signal: AbortSignal.timeout(90_000)
  })
  if (!response.ok) throw new Error(`PyPI wheel download failed (${response.status}).`)
  assertHttpsHost(response.url || artifact.url, 'files.pythonhosted.org', 'PyPI wheel response URL')
  const bytes = await readBoundedResponseBuffer(response, MAX_WHEEL_BYTES, 'PyPI wheel')
  if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256) {
    throw new Error('PyPI wheel SHA-256 or size verification failed.')
  }
  return bytes
}

async function writeVerifiedWheel(targetDirectory: string, artifact: PypiArtifact, bytes: Buffer): Promise<void> {
  const directory = join(targetDirectory, 'artifacts')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, artifact.filename)
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function licenseName(path: string): boolean {
  return /^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(basename(path))
}

export async function preservePypiLicense(
  item: MarketplacePackageV1,
  targetDirectory: string,
  wheel: Buffer,
  fetchImpl: typeof fetch
): Promise<void> {
  const zip = await JSZip.loadAsync(wheel, { checkCRC32: true })
  const entries = Object.values(zip.files)
  if (entries.length === 0 || entries.length > 20_000) throw new Error('PyPI wheel has an invalid entry count.')
  const license = entries.find((entry) => {
    const path = entry.name.replaceAll('\\', '/')
    return !entry.dir && path.split('/').every((segment) => segment && segment !== '.' && segment !== '..') &&
      licenseName(path) && (path.includes('.dist-info/licenses/') || path.includes('.dist-info/'))
  })
  let bytes: Buffer
  if (license) {
    bytes = await license.async('nodebuffer')
  } else {
    const evidence = item.licenseEvidence.find((candidate) =>
      candidate.required && candidate.includeInInstall && candidate.license === item.license &&
      licenseName(candidate.path)
    )
    const source = item.sources.find((candidate) => candidate.id === evidence?.sourceId)
    if (!evidence || source?.kind !== 'github' || !/^[0-9a-f]{40}$/i.test(source.resolvedRef)) {
      throw new Error('PyPI wheel does not preserve a LICENSE, NOTICE, or COPYING file.')
    }
    const segments = evidence.path.replaceAll('\\', '/').split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('PyPI license evidence path is unsafe.')
    }
    const url = new URL(`https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/contents/${segments.map(encodeURIComponent).join('/')}`)
    url.searchParams.set('ref', source.resolvedRef)
    const response = await fetchImpl(url.toString(), {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RailWise AI' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`PyPI license evidence request failed (${response.status}).`)
    assertHttpsHost(response.url || url.toString(), 'api.github.com', 'PyPI license evidence URL')
    const metadata = JSON.parse((await readBoundedResponseBuffer(
      response,
      MAX_LICENSE_METADATA_BYTES,
      'PyPI license evidence metadata'
    )).toString('utf8')) as {
      type?: unknown
      path?: unknown
      size?: unknown
      encoding?: unknown
      content?: unknown
    }
    const encoded = typeof metadata.content === 'string'
      ? metadata.content.replace(/\s/g, '')
      : ''
    if (metadata.type !== 'file' || metadata.path !== segments.join('/') ||
        metadata.encoding !== 'base64' || typeof metadata.size !== 'number' ||
        !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_LICENSE_BYTES ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('PyPI license evidence metadata is invalid.')
    }
    bytes = Buffer.from(encoded, 'base64')
    if (bytes.byteLength !== metadata.size) throw new Error('PyPI license evidence size is invalid.')
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LICENSE_BYTES) {
    throw new Error('PyPI wheel license file exceeds its safety limit.')
  }
  await writeFile(join(targetDirectory, 'LICENSE'), bytes, { mode: 0o600 })
}

function logicalRequirements(text: string): string[] {
  const result: string[] = []
  let current = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    current += (current ? ' ' : '') + line.replace(/\\$/, '').trim()
    if (!line.endsWith('\\')) {
      result.push(current)
      current = ''
    }
  }
  if (current) throw new Error('Python dependency lock ends with an incomplete continuation.')
  return result
}

export function validatePythonDependencyLock(text: string, primarySha256: string): void {
  if (Buffer.byteLength(text) > MAX_LOCK_BYTES || /@latest|\blatest\b/i.test(text)) {
    throw new Error('Python dependency lock is oversized or contains a mutable version.')
  }
  const requirements = logicalRequirements(text)
  if (requirements.length === 0 || requirements.length > 1_024) {
    throw new Error('Python dependency lock has an invalid requirement count.')
  }
  for (const requirement of requirements) {
    if (requirement.startsWith('-') || /(?:git\+|file:|https?:\/\/(?!files\.pythonhosted\.org\/))/i.test(requirement) ||
        (!requirement.includes('==') && !/\s@\shttps:\/\/files\.pythonhosted\.org\//i.test(requirement))) {
      throw new Error(`Python dependency lock contains an unsafe or unpinned requirement: ${requirement}`)
    }
    const hashes = [...requirement.matchAll(/--hash=sha256:([0-9a-f]{64})(?=\s|$)/gi)]
    if (hashes.length === 0) throw new Error(`Python dependency lock is missing SHA-256 hashes: ${requirement}`)
  }
  if (!text.toLowerCase().includes(primarySha256.toLowerCase())) {
    throw new Error('Python dependency lock does not include the catalog-pinned wheel hash.')
  }
}

function venvPython(targetDirectory: string): string {
  return process.platform === 'win32'
    ? join(targetDirectory, '.venv', 'Scripts', 'python.exe')
    : join(targetDirectory, '.venv', 'bin', 'python')
}

async function portableSitePackages(
  targetDirectory: string,
  environmentRoot: string,
  value: string
): Promise<string> {
  const canonicalRoot = await realpath(targetDirectory)
  const canonicalEnvironment = await realpath(environmentRoot)
  const canonical = await realpath(value.trim())
  const info = await lstat(canonical)
  if (!info.isDirectory() || !isCanonicalPathContained(canonicalEnvironment, canonical) ||
      !isCanonicalPathContained(canonicalRoot, canonical)) {
    throw new Error('Python site-packages directory escapes its isolated environment.')
  }
  const portable = relative(canonicalRoot, canonical).replaceAll('\\', '/')
  if (!portable || portable.startsWith('/') || portable.split('/').some((segment) =>
    !segment || segment === '.' || segment === '..'
  )) {
    throw new Error('Python site-packages directory is not portable.')
  }
  return portable
}

async function assertNoLinks(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('Managed Python environment contains a symbolic link.')
      if (info.isDirectory()) await visit(path)
    }
  }
  await visit(root)
}

function commandEnvironment(runtime: ManagedUvRuntimeV1): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    UV_CACHE_DIR: runtime.cacheDirectory,
    UV_PYTHON_INSTALL_DIR: runtime.pythonInstallDirectory,
    UV_DEFAULT_INDEX: 'https://pypi.org/simple',
    UV_NO_CONFIG: '1',
    UV_NO_PROGRESS: '1',
    UV_PYTHON_DOWNLOADS: 'never'
  }
  for (const key of [
    'UV_INDEX',
    'UV_INDEX_URL',
    'UV_EXTRA_INDEX_URL',
    'UV_FIND_LINKS',
    'PIP_INDEX_URL',
    'PIP_EXTRA_INDEX_URL',
    'PIP_FIND_LINKS',
    'PIP_TRUSTED_HOST',
    'PIP_CONFIG_FILE'
  ]) {
    delete environment[key]
  }
  return environment
}

export async function materializePypiPackage(
  item: MarketplacePackageV1,
  targetDirectory: string,
  options: PypiPackageMaterializerOptions = {}
): Promise<void> {
  const source = pypiSource(item)
  const fetchImpl = options.fetch ?? ((input, init) => systemFetch(input, init))
  const run = options.run ?? defaultRun
  const runtimeProvider = options.runtime ?? new ManagedUvRuntimeService()
  const artifact = await resolveArtifact(source, fetchImpl)
  const wheel = await downloadWheel(artifact, fetchImpl)
  if (await lstat(targetDirectory).then(() => true, () => false)) {
    throw new Error('Catalog package staging directory already exists.')
  }
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  try {
    await writeVerifiedWheel(targetDirectory, artifact, wheel)
    await preservePypiLicense(item, targetDirectory, wheel, fetchImpl)
    const runtime = await runtimeProvider.ensure()
    const environment = commandEnvironment(runtime)
    const inputPath = join(targetDirectory, 'requirements.in')
    const lockPath = join(targetDirectory, 'requirements.lock')
    await writeFile(inputPath, `${artifact.url}#sha256=${artifact.sha256}\n`, { mode: 0o600 })
    await run(runtime.uvPath, [
      'pip', 'compile', inputPath,
      '--output-file', lockPath,
      '--generate-hashes',
      '--no-annotate',
      '--no-header',
      '--no-strip-extras',
      '--only-binary', ':all:',
      '--python', runtime.pythonPath,
      '--no-python-downloads',
      '--exclude-newer', artifact.uploadedAt,
      '--index-strategy', 'first-index',
      '--no-progress',
      '--no-config'
    ], { cwd: targetDirectory, env: environment, timeoutMs: 15 * 60_000 })
    const lock = await readFile(lockPath, 'utf8')
    validatePythonDependencyLock(lock, artifact.sha256)

    const environmentRoot = join(targetDirectory, '.venv')
    await run(runtime.uvPath, [
      'venv', environmentRoot,
      '--relocatable',
      '--link-mode', 'copy',
      '--python', runtime.pythonPath,
      '--no-python-downloads',
      '--no-project',
      '--no-progress',
      '--no-config'
    ], { cwd: targetDirectory, env: environment, timeoutMs: 5 * 60_000 })
    const python = venvPython(targetDirectory)
    await run(runtime.uvPath, [
      'pip', 'sync', lockPath,
      '--require-hashes',
      '--strict',
      '--only-binary', ':all:',
      '--link-mode', 'copy',
      '--python', python,
      '--no-python-downloads',
      '--no-progress',
      '--no-config'
    ], { cwd: targetDirectory, env: environment, timeoutMs: 30 * 60_000 })
    const inspected = await run(python, [
      '-I', '-c', PYTHON_INSPECTION, source.packageName
    ], { cwd: targetDirectory, env: { ...process.env, PYTHONNOUSERSITE: '1' }, timeoutMs: 30_000 })
    const inspection = JSON.parse(inspected.stdout) as PythonRuntimeInspection
    const sitePackagesResult = await run(python, [
      '-I', '-c', PYTHON_SITE_PACKAGES
    ], { cwd: targetDirectory, env: { ...process.env, PYTHONNOUSERSITE: '1' }, timeoutMs: 30_000 })
    const sitePackages = await portableSitePackages(
      targetDirectory,
      environmentRoot,
      sitePackagesResult.stdout
    )
    const expectedEntrypoints = item.components
      .map((component) => component.runtime)
      .filter((component) => component.kind === 'uv')
      .map((component) => component.executable)
    if (normalizePackageName(inspection.name) !== normalizePackageName(source.packageName) ||
        inspection.version !== source.version || !Array.isArray(inspection.entrypoints) ||
        expectedEntrypoints.some((entrypoint) => !inspection.entrypoints.includes(entrypoint))) {
      throw new Error('Installed Python package version or executable entry point is invalid.')
    }
    await rm(join(environmentRoot, process.platform === 'win32' ? 'Scripts' : 'bin'), {
      recursive: true,
      force: true
    })
    await assertNoLinks(environmentRoot)
    await writeFile(join(targetDirectory, 'workwise-python-launcher.py'), PYTHON_LAUNCHER, { mode: 0o600 })
    await writeFile(join(targetDirectory, 'workwise-python-runtime.json'), `${JSON.stringify({
      schema: 'workwise.python-runtime',
      version: 1,
      packageName: source.packageName,
      packageVersion: source.version,
      entrypoints: expectedEntrypoints,
      uvVersion: runtime.uvVersion,
      pythonVersion: runtime.pythonVersion,
      wheel: artifact,
      sitePackages,
      lockSha256: sha256(lock)
    }, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
