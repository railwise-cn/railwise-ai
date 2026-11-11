#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { websiteStaticTransport } from './deploy-website-release.mjs'

const manifestPath = fileURLToPath(new URL('../src/shared/managed-dependencies.json', import.meta.url))
const sourceHosts = new Set(['github.com', 'api.github.com', 'raw.githubusercontent.com', 'files.pythonhosted.org', 'www.python.org'])
const responseHosts = new Set([...sourceHosts, 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'www.railwise.cn'])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function validateManifest(manifest) {
  if (manifest.schema !== 'railwise.managed-dependencies.v1' || manifest.publicBase !== 'https://www.railwise.cn/downloads/railwise-ai/dependencies' || !Array.isArray(manifest.files)) throw new Error('Invalid dependency manifest.')
  const ids = new Set()
  for (const file of manifest.files) {
    const url = new URL(file.sourceUrl)
    if (url.protocol !== 'https:' || !sourceHosts.has(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid upstream source for ${file.id}.`)
    if (!/^[a-z0-9-]+$/.test(file.id) || ids.has(file.id)) throw new Error('Duplicate or invalid dependency identity.')
    ids.add(file.id)
    if (![file.component, file.version, file.name].every(value => typeof value === 'string' && /^[A-Za-z0-9._+-]+$/.test(value) && !value.startsWith('.')) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Unsafe immutable dependency path.')
    if (file.mirrorPath !== [file.component, file.version, file.sha256, file.name].join('/')) throw new Error('Dependency path must include its exact content hash.')
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 128 * 1024 * 1024 || !file.license) throw new Error('Missing dependency size or license.')
  }
  for (const file of manifest.files.filter(item => item.role === 'runtime')) {
    if (!file.licenseIds?.length || !file.sourceIds?.length || [...file.licenseIds, ...file.sourceIds].some(id => !ids.has(id))) throw new Error(`Missing source/license records for ${file.id}.`)
  }
  return manifest
}

export async function checkedBytes(response, file) {
  if (!response.ok) throw new Error(`Download for ${file.id} failed (${response.status}).`)
  if (response.url) {
    const url = new URL(response.url)
    if (url.protocol !== 'https:' || !responseHosts.has(url.hostname) || url.username || url.password) throw new Error('Dependency redirected to an unapproved source.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Dependency response has no body.')
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > file.size) throw new Error(`Dependency exceeds locked size: ${file.id}.`)
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  const bytes = Buffer.concat(chunks, size)
  if (bytes.length !== file.size || sha(bytes) !== file.sha256) throw new Error(`Dependency integrity mismatch: ${file.id}.`)
  return bytes
}

export async function r2Matches(client, bucket, key, file) {
  let result
  try { result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })) }
  catch (error) { if (error?.$metadata?.httpStatusCode === 404) return false; throw error }
  const digest = createHash('sha256')
  let size = 0
  for await (const chunk of result.Body) { size += chunk.length; if (size > file.size) throw new Error(`Existing immutable object conflicts: ${file.id}.`); digest.update(chunk) }
  if (size !== file.size || digest.digest('hex') !== file.sha256) throw new Error(`Existing immutable object conflicts: ${file.id}.`)
  return true
}

export const finalizeWebsite = String.raw`set -euo pipefail
python3 - "$1" "$2" <<'PY'
import hashlib,json,os,pathlib,shutil,sys
root=pathlib.Path(sys.argv[1]).resolve()
stage=pathlib.Path(sys.argv[2]).resolve()
base=root/'dependencies'
if stage.name!='payload' or stage.parent.parent != base.resolve() or not stage.parent.name.startswith('.deploy-'): raise RuntimeError('Invalid dependency staging directory')
manifest=json.loads((stage/'manifest.json').read_text())
for item in manifest['files']:
    rel=pathlib.PurePosixPath(item['mirrorPath'])
    if '..' in rel.parts or rel.is_absolute(): raise RuntimeError('Unsafe dependency path')
    source=stage/item['id']
    target=base.joinpath(*rel.parts)
    if source.is_symlink() or not source.is_file(): raise RuntimeError('Invalid staged dependency')
    data=source.read_bytes()
    if len(data)!=item['size'] or hashlib.sha256(data).hexdigest()!=item['sha256']: raise RuntimeError('Staged integrity mismatch')
    target.parent.mkdir(parents=True,exist_ok=True)
    if os.path.commonpath([str(base.resolve()),str(target.parent.resolve())]) != str(base.resolve()): raise RuntimeError('Dependency target escaped storage')
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_file() or target.stat().st_size!=item['size'] or hashlib.sha256(target.read_bytes()).hexdigest()!=item['sha256']: raise RuntimeError('Immutable dependency conflict')
    else:
        os.chmod(source,0o644)
        try: os.link(source,target)
        except FileExistsError:
            if target.is_symlink() or hashlib.sha256(target.read_bytes()).hexdigest()!=item['sha256']: raise RuntimeError('Concurrent dependency conflict')
shutil.rmtree(stage.parent)
PY`

export async function stageManagedDependencies() {
  const manifestBytes = await readFile(manifestPath)
  const manifest = validateManifest(JSON.parse(manifestBytes))
  for (const name of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (!process.env[name]) throw new Error(`Missing ${name}.`)
  if (!/^[a-f0-9]{32}$/.test(process.env.R2_ACCOUNT_ID)) throw new Error('Invalid R2 account identifier.')
  const client = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    requestHandler: new NodeHttpHandler({ connectionTimeout: 15_000, requestTimeout: 120_000 }) })
  const directory = await mkdtemp(join(tmpdir(), 'railwise-dependencies-'))
  const receipt = { schema: 'railwise.dependency-mirror-evidence.v1', sourceHead: process.env.GITHUB_SHA ?? '', manifestSha256: sha(manifestBytes), stagingId: randomUUID(), status: 'staging', files: [] }
  try {
    await writeFile('dependency-mirror-evidence.json', `${JSON.stringify(receipt, null, 2)}\n`)
    await writeFile(join(directory, 'manifest.json'), manifestBytes)
    const downloads = []
    for (const file of manifest.files) {
      const key = `railwise-ai/dependencies/${file.mirrorPath}`
      if (!await r2Matches(client, process.env.R2_BUCKET, key, file)) {
        const bytes = await checkedBytes(await fetch(file.sourceUrl, { signal: AbortSignal.timeout(120_000) }), file)
        try { await client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: bytes, IfNoneMatch: '*', CacheControl: 'public,max-age=31536000,immutable', Metadata: { sha256: file.sha256 } })) }
        catch (error) { if (error?.$metadata?.httpStatusCode !== 412) throw error }
        await r2Matches(client, process.env.R2_BUCKET, key, file)
      }
      downloads.push({ name: file.id, size: file.size,
        url: await getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }), { expiresIn: 3600 }) })
      console.log(`Verified immutable dependency ${file.id}`)
    }
    const ssh = websiteStaticTransport.readSshConfig()
    websiteStaticTransport.ensurePublicDownloadAlias(ssh)
    const remote = `${ssh.root}/dependencies/.deploy-${receipt.stagingId}/payload`
    console.log(`Dependency website staging ${receipt.stagingId}`)
    websiteStaticTransport.runRemote(ssh, 'set -euo pipefail\nmkdir -p -- "$1"\nchmod 700 -- "$1"\n', [remote])
    const transferManifest = join(directory, 'downloads.json')
    const workerPath = join(directory, 'r2-download-worker.py')
    await writeFile(transferManifest, JSON.stringify(downloads), { mode: 0o600 })
    await writeFile(workerPath, websiteStaticTransport.r2DownloadWorker, { mode: 0o700 })
    websiteStaticTransport.copyFile(ssh, transferManifest, `${remote}/.r2-downloads.json`)
    websiteStaticTransport.copyFile(ssh, workerPath, `${remote}/.r2-download-worker.py`)
    websiteStaticTransport.copyFile(ssh, join(directory, 'manifest.json'), `${remote}/manifest.json`)
    websiteStaticTransport.runRemote(ssh, websiteStaticTransport.startR2DownloadScript, [`${remote}/.r2-downloads.json`, remote])
    await websiteStaticTransport.waitForRemoteR2Download(ssh, remote, { timeoutMs: 25 * 60_000 })
    websiteStaticTransport.runRemote(ssh, finalizeWebsite, [ssh.root, remote])
    for (const file of manifest.files) {
      const url = `${manifest.publicBase}/${file.mirrorPath.split('/').map(encodeURIComponent).join('/')}`
      await checkedBytes(await fetch(url, { signal: AbortSignal.timeout(120_000) }), file)
      receipt.files.push({ id: file.id, url, sha256: file.sha256, size: file.size, verified: true })
    }
    receipt.status = 'verified'
    await writeFile('dependency-mirror-evidence.json', `${JSON.stringify(receipt, null, 2)}\n`)
    console.log(`Verified ${receipt.files.length} public dependencies for manifest ${receipt.manifestSha256}`)
  } catch (error) {
    receipt.status = 'failed'
    await writeFile('dependency-mirror-evidence.json', `${JSON.stringify(receipt, null, 2)}\n`)
    throw error
  } finally { client.destroy(); await rm(directory, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = process.argv.includes('--stage') ? stageManagedDependencies : async () => {
    const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
    console.log(JSON.stringify({ files: manifest.files.length, bytes: manifest.files.reduce((total, file) => total + file.size, 0) }))
  }
  run().catch(error => { console.error(`[managed-dependencies] ${error.message}`); process.exitCode = 1 })
}
