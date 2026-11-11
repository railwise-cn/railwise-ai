import type { McpConnectionCheckV1, McpServerConfigV2 } from './agent-workbench'

/** The service validates the configuration hash before exposing this evidence. */
export function currentMcpConnectionCheck(server?: McpServerConfigV2): McpConnectionCheckV1 | undefined {
  const check = server?.connectionCheck
  if (!check || check.serverRevision !== server?.revision || check.credentialRefId !== server?.credentialRef?.id ||
    !/^[a-f0-9]{64}$/.test(check.configurationHash) || !Number.isFinite(Date.parse(check.checkedAt))) return undefined
  return check
}

export function mcpToolDiscoveryPassed(server?: McpServerConfigV2): boolean {
  const check = currentMcpConnectionCheck(server)
  return Boolean(check?.state === 'connected' && check.authorized && check.verification === 'tool_discovery' &&
    Number.isSafeInteger(check.toolCount) && check.toolCount! > 0)
}
