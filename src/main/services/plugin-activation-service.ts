import { ZOTERO_READ_TOOLS, isApprovedUpstreamPackage } from '../../shared/engineering-marketplace'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  BundledPackageRuntimeV1,
  InstalledPackageV1,
  MarketplaceComponentV1,
  MarketplacePackageV1
} from '../../shared/marketplace'
import type { McpServerConfigV2 } from '../../shared/agent-workbench'
import { isCanonicalPathContained } from './canonical-containment'
import {
  MANAGED_PYTHON_VERSION,
  MANAGED_UV_VERSION,
  ManagedUvRuntimeService,
  type ManagedUvRuntimeV1
} from './managed-uv-runtime-service'
import type { McpConfigService } from './mcp-config-service'

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024
const MAX_RUNTIME_METADATA_BYTES = 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/i

export type ActivatePluginPackageOptions = {
  item: MarketplacePackageV1
  installed: InstalledPackageV1
  workspaceRoot?: string
  mcpConfigService: McpConfigService
  idempotencyKey: string
  managedUvRuntime?: { ensure(): Promise<ManagedUvRuntimeV1> }
}

function permissionGranted(item: MarketplacePackageV1, installed: InstalledPackageV1): boolean {
  const decisions = new Map(installed.permissions.map((permission) => [
    permission.permissionId,
    permission.decision
  ]))
  return item.permissions.every((permission) => decisions.get(permission.id) === 'granted')
}

function replaceWorkspace(value: string, workspaceRoot: string | undefined): string {
  if (!value.includes('${workspaceRoot}')) return value
  return workspaceRoot ? value.replaceAll('${workspaceRoot}', workspaceRoot) : ''
}

async function verifiedArtifactPath(root: string, relativePath: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  const target = resolve(canonicalRoot, relativePath)
  if (!isCanonicalPathContained(canonicalRoot, target)) throw new Error('Plugin runtime path escapes its artifact.')
  const info = await lstat(target)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Plugin runtime entrypoint must be a regular file.')
  const canonical = await realpath(target)
  if (!isCanonicalPathContained(canonicalRoot, canonical)) throw new Error('Plugin runtime entrypoint escapes its artifact.')
  return canonical
}

async function verifiedArtifactDirectory(root: string, relativePath: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  const target = resolve(canonicalRoot, relativePath)
  if (!isCanonicalPathContained(canonicalRoot, target)) throw new Error('Plugin runtime directory escapes its artifact.')
  const info = await lstat(target)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Plugin runtime directory must be a real directory.')
  const canonical = await realpath(target)
  if (!isCanonicalPathContained(canonicalRoot, canonical)) throw new Error('Plugin runtime directory escapes its artifact.')
  return canonical
}

async function npmEntrypoint(
  root: string,
  packageName: string,
  executable: string
): Promise<string> {
  const packageRoot = join(root, 'node_modules', ...packageName.split('/').filter(Boolean))
  const manifestPath = await verifiedArtifactPath(packageRoot, 'package.json')
  const info = await lstat(manifestPath)
  if (info.size > MAX_PACKAGE_JSON_BYTES) throw new Error('Plugin npm package manifest exceeds 1 MiB.')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { bin?: string | Record<string, string> }
  const bin = typeof manifest.bin === 'string'
    ? manifest.bin
    : manifest.bin?.[executable] ?? Object.values(manifest.bin ?? {})[0]
  if (!bin) throw new Error(`Plugin npm executable was not found: ${executable}.`)
  return verifiedArtifactPath(packageRoot, bin)
}

async function bundledArgument(
  root: string,
  value: string,
  workspaceRoot: string | undefined
): Promise<string> {
  const withWorkspace = replaceWorkspace(value, workspaceRoot)
  if (!withWorkspace.includes('${__dirname}')) {
    return withWorkspace.startsWith('./')
      ? verifiedArtifactPath(root, withWorkspace)
      : withWorkspace
  }
  if (withWorkspace.indexOf('${__dirname}') !== withWorkspace.lastIndexOf('${__dirname}')) {
    throw new Error('Bundled runtime argument contains repeated package directory placeholders.')
  }
  const [prefix, rawSuffix = ''] = withWorkspace.split('${__dirname}')
  if (prefix && !/^--[A-Za-z0-9][A-Za-z0-9-]*=$/.test(prefix)) {
    throw new Error('Bundled runtime package directory placeholder has an unsafe prefix.')
  }
  const suffix = rawSuffix.replaceAll('\\', '/')
  if (suffix && !suffix.startsWith('/')) {
    throw new Error('Bundled runtime package directory placeholder must reference a package path.')
  }
  const canonicalRoot = await realpath(root)
  const target = resolve(canonicalRoot, suffix.replace(/^\/+/, ''))
  if (!isCanonicalPathContained(canonicalRoot, target)) {
    throw new Error('Bundled runtime argument escapes its artifact.')
  }
  const info = await lstat(target)
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error('Bundled runtime argument must reference a regular package path.')
  }
  const canonical = await realpath(target)
  if (!isCanonicalPathContained(canonicalRoot, canonical)) {
    throw new Error('Bundled runtime argument escapes its artifact.')
  }
  return `${prefix}${canonical}`
}

async function managedUvLaunch(
  runtime: BundledPackageRuntimeV1,
  artifactRoot: string,
  workspaceRoot: string | undefined,
  provider: { ensure(): Promise<ManagedUvRuntimeV1> }
): Promise<{ command: string; args: string[] }> {
  if (runtime.managedRuntime !== 'uv') throw new Error('Managed MCPB runtime metadata is invalid.')
  const executable = runtime.executable?.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase()
  if (executable !== 'uv' && executable !== 'uv.exe') {
    throw new Error('Managed MCPB runtime must use the RailWise AI uv executable.')
  }
  const originalArgs = runtime.args ?? []
  if (originalArgs[0] !== 'run' || originalArgs.length < 2) {
    throw new Error('Managed MCPB uv runtime must use a direct uv run entrypoint.')
  }
  const entrypoint = await verifiedArtifactPath(artifactRoot, runtime.entrypoint)
  const mapped = await Promise.all(originalArgs.map((arg) =>
    bundledArgument(artifactRoot, arg, workspaceRoot)
  ))
  if (mapped[1] !== entrypoint) {
    throw new Error('Managed MCPB uv command does not match its reviewed entrypoint.')
  }
  const managed = await provider.ensure()
  const command = await realpath(managed.uvPath)
  const commandInfo = await lstat(command)
  if (commandInfo.isSymbolicLink() || !commandInfo.isFile()) {
    throw new Error('Managed uv executable is invalid.')
  }
  return {
    command,
    args: [
      '--cache-dir', managed.cacheDirectory,
      '--managed-python',
      '--no-python-downloads',
      '--no-progress',
      '--directory', await realpath(artifactRoot),
      '--no-config',
      'run',
      '--locked',
      '--isolated',
      '--no-env-file',
      '--no-editable',
      '--python', managed.pythonPath,
      entrypoint,
      ...mapped.slice(2)
    ]
  }
}

async function pythonLaunch(
  root: string,
  packageName: string,
  version: string,
  wheelSha256: string,
  executable: string,
  args: string[],
  workspaceRoot: string | undefined,
  provider: { ensure(): Promise<ManagedUvRuntimeV1> }
): Promise<{ command: string; args: string[] }> {
  const metadataPath = await verifiedArtifactPath(root, 'workwise-python-runtime.json')
  const metadataInfo = await lstat(metadataPath)
  if (metadataInfo.size > MAX_RUNTIME_METADATA_BYTES) throw new Error('Plugin Python runtime metadata exceeds 1 MiB.')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
    schema?: unknown
    version?: unknown
    packageName?: unknown
    packageVersion?: unknown
    entrypoints?: unknown
    sitePackages?: unknown
    lockSha256?: unknown
    uvVersion?: unknown
    pythonVersion?: unknown
    wheel?: { sha256?: unknown }
  }
  if (metadata.schema !== 'workwise.python-runtime' || metadata.version !== 1 ||
      metadata.packageName !== packageName || metadata.packageVersion !== version ||
      !Array.isArray(metadata.entrypoints) || !metadata.entrypoints.includes(executable) ||
      typeof metadata.sitePackages !== 'string' || !metadata.sitePackages ||
      typeof metadata.lockSha256 !== 'string' || !SHA256.test(metadata.lockSha256) ||
      metadata.uvVersion !== MANAGED_UV_VERSION ||
      metadata.pythonVersion !== MANAGED_PYTHON_VERSION ||
      metadata.wheel?.sha256 !== wheelSha256) {
    throw new Error('Plugin Python runtime metadata does not match its reviewed component.')
  }
  const lockPath = await verifiedArtifactPath(root, 'requirements.lock')
  const lockInfo = await lstat(lockPath)
  if (lockInfo.size > 8 * 1024 * 1024) throw new Error('Plugin Python dependency lock exceeds 8 MiB.')
  const lock = await readFile(lockPath)
  if (createHash('sha256').update(lock).digest('hex') !== metadata.lockSha256.toLowerCase()) {
    throw new Error('Plugin Python dependency lock failed integrity verification.')
  }
  const launcher = await verifiedArtifactPath(root, 'workwise-python-launcher.py')
  const sitePackages = await verifiedArtifactDirectory(root, metadata.sitePackages)
  const managed = await provider.ensure()
  if (managed.uvVersion !== metadata.uvVersion || managed.pythonVersion !== metadata.pythonVersion) {
    throw new Error('Managed Python runtime version does not match the reviewed plugin environment.')
  }
  const python = await realpath(managed.pythonPath)
  const pythonInfo = await lstat(python)
  if (pythonInfo.isSymbolicLink() || !pythonInfo.isFile()) {
    throw new Error('Managed Python executable is invalid.')
  }
  return {
    command: python,
    args: [
      '-I',
      launcher,
      sitePackages,
      packageName,
      executable,
      ...args.map((arg) => replaceWorkspace(arg, workspaceRoot))
    ]
  }
}

async function stdioLaunch(
  component: Extract<MarketplaceComponentV1, { type: 'mcp' }>,
  artifactRoot: string,
  workspaceRoot: string | undefined,
  managedUvRuntime: { ensure(): Promise<ManagedUvRuntimeV1> }
): Promise<{ command: string; args: string[] } | null> {
  const runtime = component.runtime
  if (runtime.kind === 'npm') {
    const entrypoint = await npmEntrypoint(
      artifactRoot,
      runtime.packageName,
      runtime.executable
    )
    return {
      command: process.platform === 'win32' ? 'node.exe' : 'node',
      args: [entrypoint, ...runtime.args.map((arg) => replaceWorkspace(arg, workspaceRoot))]
    }
  }
  if (runtime.kind === 'bundled') {
    if (runtime.managedRuntime === 'uv') {
      return managedUvLaunch(runtime, artifactRoot, workspaceRoot, managedUvRuntime)
    }
    const entrypoint = await verifiedArtifactPath(artifactRoot, runtime.entrypoint)
    const executable = runtime.executable?.trim() || entrypoint
    const command = await bundledArgument(artifactRoot, executable, workspaceRoot)
    const args = await Promise.all((runtime.args ?? []).map((arg) =>
      bundledArgument(artifactRoot, arg, workspaceRoot)
    ))
    if (command !== entrypoint && !args.includes(entrypoint)) args.unshift(entrypoint)
    return { command, args }
  }
  if (runtime.kind === 'uv') {
    return pythonLaunch(
      artifactRoot,
      runtime.packageName,
      runtime.version,
      runtime.install.digest.value,
      runtime.executable,
      runtime.args,
      workspaceRoot,
      managedUvRuntime
    )
  }
  return null
}

export async function activatePluginPackage(options: ActivatePluginPackageOptions): Promise<{ mcpChanged: boolean }> {
  const enabledByPermissions = permissionGranted(options.item, options.installed)
  const managedUvRuntime = options.managedUvRuntime ?? new ManagedUvRuntimeService()
  const workspaceRoot = options.installed.scope === 'workspace'
    ? options.installed.workspaceRoot
    : options.workspaceRoot
  if (options.installed.scope === 'workspace' &&
      (!workspaceRoot || (options.workspaceRoot &&
        resolve(options.workspaceRoot) !== resolve(workspaceRoot)))) {
    throw new Error('Workspace plugin activation must use its installed workspace.')
  }
  if (!options.item.components.some(component => component.type === 'mcp') && !options.installed.rollback.available) {
    return { mcpChanged: false }
  }
  const scope = options.installed.scope === 'workspace' ? 'workspace' as const : 'global' as const
  const existingServers = await options.mcpConfigService.list(workspaceRoot)
  const existingById = new Map(existingServers.map((server) => [server.id, server]))
  const componentIds = new Set<string>()
  const operations: Array<{
    request: Parameters<McpConfigService['save']>[0]
    previous?: McpServerConfigV2
  }> = []
  for (const component of options.item.components) {
    if (component.type !== 'mcp' || component.runtime.kind === 'system') continue
    if (componentIds.has(component.id)) throw new Error(`Plugin declares duplicate MCP component ID: ${component.id}.`)
    componentIds.add(component.id)
    const existing = existingById.get(component.id)
    if (existing && existing.source !== 'managed-tool') {
      throw new Error(`Plugin MCP component conflicts with an existing user server: ${component.id}.`)
    }
    const common = {
      id: component.id,
      name: component.name,
      scope,
      ...(scope === 'workspace' ? { workspaceRoot } : {}),
      timeoutMs: 30_000,
      source: 'managed-tool' as const,
      credentialEnvironmentVariables: options.item.auth.type === 'token'
        ? options.item.auth.environmentVariables
        : undefined,
      toolPolicy: isApprovedUpstreamPackage(options.item) ? { '*': 'deny' as const, ...Object.fromEntries(ZOTERO_READ_TOOLS.map(name => [name, 'allow' as const])) } : {},
      ...(isApprovedUpstreamPackage(options.item) ? { managedPreset: 'zotero-readonly' as const, readOnlyTools: [...ZOTERO_READ_TOOLS] } : {}),
      enabled: enabledByPermissions && (!isApprovedUpstreamPackage(options.item) || existing?.enabled === true),
      revision: existing?.revision
    }
    if (component.runtime.kind === 'remote') {
      operations.push({
        request: {
          config: {
            ...common,
            transport: 'http',
            url: component.runtime.endpoint,
            ...(options.item.auth.type === 'oauth'
              ? {
                  oauth: {
                    resource: component.runtime.oauthResource ?? component.runtime.endpoint,
                    redirectUri: 'http://127.0.0.1:17864/oauth/callback',
                    scopes: options.item.auth.scopes ?? []
                  }
                }
              : {})
          },
          expectedRevision: existing?.revision ?? 0,
          idempotencyKey: `${options.idempotencyKey}:${component.id}`
        },
        ...(existing ? { previous: existing } : {})
      })
      continue
    }
    const launch = await stdioLaunch(
      component,
      options.installed.artifact.location,
      workspaceRoot,
      managedUvRuntime
    )
    if (!launch) continue
    const hasMissingWorkspace = launch.args.some((arg) => !arg)
    operations.push({
      request: {
        config: {
          ...common,
          transport: 'stdio',
          command: launch.command,
          args: launch.args.filter(Boolean),
          enabled: common.enabled && !hasMissingWorkspace
        },
        expectedRevision: existing?.revision ?? 0,
        idempotencyKey: `${options.idempotencyKey}:${component.id}`
      },
      ...(existing ? { previous: existing } : {})
    })
  }

  if (options.installed.rollback.available) {
    const activeComponentIds = new Set(options.item.components
      .filter((component) => component.type === 'mcp')
      .map((component) => component.id))
    for (const previous of options.installed.rollback.components) {
      if (activeComponentIds.has(previous.componentId)) continue
      const existing = existingServers.find((server) =>
        server.id === previous.componentId && server.source === 'managed-tool'
      )
      if (!existing) continue
      operations.push({
        request: {
          config: { ...existing, enabled: false },
          expectedRevision: existing.revision,
          idempotencyKey: `${options.idempotencyKey}:disable:${previous.componentId}`
        },
        previous: existing
      })
    }
  }

  const applied: Array<{
    previous?: McpServerConfigV2
    saved: McpServerConfigV2
  }> = []
  try {
    for (const operation of operations) {
      const saved = await options.mcpConfigService.save(operation.request)
      applied.push({ saved, ...(operation.previous ? { previous: operation.previous } : {}) })
    }
  } catch (error) {
    const compensationErrors: unknown[] = []
    for (const [index, operation] of [...applied].reverse().entries()) {
      try {
        await options.mcpConfigService.save({
          config: operation.previous ?? { ...operation.saved, enabled: false },
          expectedRevision: operation.saved.revision,
          idempotencyKey: `${options.idempotencyKey}:compensate:${index}:${operation.saved.id}`
        })
      } catch (compensationError) {
        compensationErrors.push(compensationError)
      }
    }
    if (compensationErrors.length > 0) {
      throw new AggregateError(
        [error, ...compensationErrors],
        'Plugin MCP activation failed and its configuration compensation was incomplete.'
      )
    }
    throw error
  }
  return { mcpChanged: operations.length > 0 }
}
