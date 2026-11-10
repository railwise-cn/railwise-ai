import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  DEFAULT_SANDBOX_MODE,
  SandboxModeSchema,
  type SandboxMode
} from '../../contracts/policy.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'
const workspaceRoot = (workspace: string): string => resolve(workspace.trim() || process.cwd())
import type { ApprovalPolicy } from '../../contracts/policy.js'

export type SandboxBlock = {
  code:
    | 'sandbox_read_only'
    | 'sandbox_command_blocked'
    | 'sandbox_write_blocked'
    | 'execution_grant_scope'
    | 'execution_grant_expired'
    | 'workspace_path_blocked'
    | 'network_scope_blocked'
    | 'connector_scope_missing'
    | 'external_target_blocked'
  message: string
}

export function effectiveSandboxMode(
  context?: Pick<ToolHostContext, 'sandboxMode' | 'executionGrant'>
): SandboxMode {
  const requested = context?.executionGrant?.sandboxMode ?? context?.sandboxMode
  const parsed = SandboxModeSchema.safeParse(requested)
  const mode = parsed.success ? parsed.data : DEFAULT_SANDBOX_MODE
  const trust = context?.executionGrant?.workspaceTrust
  if (trust === 'read-only') return 'read-only'
  if (trust !== undefined && trust !== 'full-access' && mode === 'danger-full-access') {
    return 'workspace-write'
  }
  return mode
}

/** The most restrictive policy wins when an older caller supplies both values. */
export function effectiveApprovalPolicy(
  context?: Pick<ToolHostContext, 'approvalPolicy' | 'executionGrant'>
): ApprovalPolicy {
  const current = context?.approvalPolicy ?? 'auto'
  const granted = context?.executionGrant?.approvalPolicy
  if (!granted) return current
  const rank = (value: ApprovalPolicy): number => {
    switch (value) {
      case 'never': return 4
      case 'untrusted': return 3
      case 'on-request': return 2
      case 'suggest': return 1
      case 'auto': return 0
    }
  }
  return rank(granted) > rank(current) ? granted : current
}

export function isToolAdvertisedInSandbox(
  tool: Pick<LocalTool, 'toolKind' | 'name'>,
  context?: Pick<ToolHostContext, 'workspace' | 'sandboxMode' | 'executionGrant'>
): boolean {
  if (!context) return true
  return sandboxBlockForTool(tool, context) === null
}

export function sandboxBlockForTool(
  tool: Pick<LocalTool, 'toolKind' | 'name'>,
  context: Pick<ToolHostContext, 'workspace' | 'sandboxMode' | 'executionGrant'>
): SandboxBlock | null {
  const grantBlock = executionGrantBlock(context)
  if (grantBlock) return grantBlock
  const mode = effectiveSandboxMode(context)
  if (mode === 'danger-full-access') {
    if (tool.toolKind === 'command_execution' && context.executionGrant && (!context.executionGrant.pathAllowlist.includes('*') || !context.executionGrant.networkAllowlist.includes('*'))) return { code: 'sandbox_command_blocked', message: 'Host Shell cannot enforce a restricted path/network grant; use a typed tool or explicitly authorize full host access.' }
    return null
  }
  if (isInteractiveGuiGateTool(tool.name)) return null

  if (tool.toolKind === 'file_change') {
    if (mode === 'workspace-write') return null
    return {
      code: mode === 'read-only' ? 'sandbox_read_only' : 'sandbox_write_blocked',
      message:
        mode === 'read-only'
          ? `tool ${tool.name} is blocked by the read-only sandbox`
          : `tool ${tool.name} is blocked because ${mode} does not allow in-process file mutation`
    }
  }

  if (tool.toolKind === 'command_execution') {
    return {
      code: 'sandbox_command_blocked',
      message:
        mode === 'read-only'
          ? `tool ${tool.name} is blocked by the read-only sandbox`
          : `tool ${tool.name} is blocked because ${mode} cannot sandbox host shell commands`
    }
  }

  return null
}

export function canWritePath(
  absolutePath: string,
  context: Pick<ToolHostContext, 'workspace' | 'sandboxMode' | 'executionGrant'>
): { ok: true } | { ok: false; block: SandboxBlock } {
  const grantBlock = executionGrantBlock(context)
  if (grantBlock) return { ok: false, block: grantBlock }
  const mode = effectiveSandboxMode(context)
  const pathBlock = grantPathBlock(absolutePath, context)
  if (pathBlock) return { ok: false, block: pathBlock }
  if (mode === 'danger-full-access') return { ok: true }
  if (mode === 'read-only') {
    return {
      ok: false,
      block: {
        code: 'sandbox_read_only',
        message: `writing is blocked by the read-only sandbox: ${absolutePath}`
      }
    }
  }
  if (mode === 'external-sandbox') {
    return {
      ok: false,
      block: {
        code: 'sandbox_write_blocked',
        message: `writing is blocked because external-sandbox is not enforced by in-process file tools: ${absolutePath}`
      }
    }
  }

  const root = workspaceRoot(context.workspace)
  const resolvedPath = isAbsolute(absolutePath) ? resolve(absolutePath) : resolve(root, absolutePath)
  if (isPathInsideOrEqual(root, resolvedPath)) return { ok: true }
  return {
    ok: false,
    block: {
      code: 'workspace_path_blocked',
      message: `writing is limited to the workspace sandbox: ${absolutePath}`
    }
  }
}

export function assertCanWritePath(
  absolutePath: string,
  context: Pick<ToolHostContext, 'workspace' | 'sandboxMode' | 'executionGrant'>
): void {
  const decision = canWritePath(absolutePath, context)
  if (!decision.ok) throw Object.assign(new Error(decision.block.message), { code: decision.block.code })
}

export function executionGrantBlock(
  context: Pick<ToolHostContext, 'workspace' | 'executionGrant'> & Partial<Pick<ToolHostContext, 'threadId' | 'turnId'>>
): SandboxBlock | null {
  const grant = context.executionGrant
  if (!grant) return null
  if ((context.threadId && context.threadId !== grant.threadId) || (context.turnId && context.turnId !== grant.turnId)) return { code: 'execution_grant_scope', message: 'Execution grant belongs to another task Turn.' }
  const workspace = context.workspace.trim() ? workspaceRoot(context.workspace) : ''
  const grantedWorkspace = grant.workspaceRoot.trim() ? workspaceRoot(grant.workspaceRoot) : ''
  if (workspace !== grantedWorkspace) {
    return {
      code: 'execution_grant_scope',
      message: `execution grant is scoped to ${grant.workspaceRoot}, not ${context.workspace}`
    }
  }
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
    return {
      code: 'execution_grant_expired',
      message: `execution grant expired at ${grant.expiresAt}`
    }
  }
  return null
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  const rel = relative(rootPath, candidatePath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isInteractiveGuiGateTool(toolName: string): boolean {
  return toolName === 'user_input' || toolName === 'request_user_input'
}

/** Apply path scope to reads as well as writes; tools must still canonicalize symlinks. */
export function grantPathBlock(absolutePath: string, context: Pick<ToolHostContext, 'workspace' | 'executionGrant'>): SandboxBlock | null {
  const grant = context.executionGrant
  if (!grant) return null
  const target = isAbsolute(absolutePath) ? resolve(absolutePath) : resolve(workspaceRoot(context.workspace), absolutePath)
  if (grant.pathAllowlist.some(root => root === '*' || (root && isPathInsideOrEqual(root, target)))) return null
  return { code: 'workspace_path_blocked', message: `Path is outside the execution grant: ${absolutePath}` }
}

export function assertGrantAllowsNetwork(url: string, context: Pick<ToolHostContext, 'executionGrant'>): void {
  const grant = context.executionGrant
  if (!grant) return
  let parsed: URL
  try { parsed = new URL(url) } catch { throw Object.assign(new Error('Invalid network target.'), { code: 'network_scope_blocked' }) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Object.assign(new Error('Network target is not allowed.'), { code: 'network_scope_blocked' })
  const allowed = grant.networkAllowlist.some(entry => {
    if (entry === '*') return true
    try { return new URL(entry).origin === parsed.origin } catch { return entry.toLowerCase() === parsed.hostname.toLowerCase() }
  })
  if (!allowed) throw Object.assign(new Error(`Network target is outside the execution grant: ${parsed.origin}`), { code: 'network_scope_blocked' })
}

export function assertGrantConnectorScopes(scopes: readonly string[], context: Pick<ToolHostContext, 'executionGrant'>): void {
  const grant = context.executionGrant
  if (!grant) return
  const missing = scopes.filter(scope => !grant.connectorScopes.includes(scope))
  if (missing.length) throw Object.assign(new Error(`Connector permission required: ${missing.join(', ')}`), { code: 'connector_scope_missing' })
}

/** An opaque, exact action key prevents another provider or operation reusing a target ID. */
export function externalTargetGrantKey(provider: string, operation: string, target: string): string {
  return JSON.stringify([provider, operation, target])
}

/** Lists/detail reads remain available before the user selects the finite write scope. */
export function assertGrantAllowsExternalTarget(
  provider: string,
  operation: string,
  target: string,
  context: Pick<ToolHostContext, 'executionGrant' | 'assertExternalTarget'>
): void {
  if (!['approve', 'reject', 'complete', 'send', 'transfer'].includes(operation)) return
  if (context.assertExternalTarget) {
    context.assertExternalTarget(provider, operation, target)
    return
  }
  // Older internal callers can execute only actions explicitly captured by
  // their immutable Grant. An empty list never means unrestricted writes.
  if (context.executionGrant?.externalTargets.includes(externalTargetGrantKey(provider, operation, target))) return
  throw Object.assign(new Error('External action target is outside the reviewed execution scope.'), { code: 'external_target_blocked' })
}
