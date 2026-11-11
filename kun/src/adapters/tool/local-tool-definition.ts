import type { LocalTool } from './local-tool-host.js'

/**
 * Define a local tool without importing the LocalToolHost runtime.
 *
 * Keeping this builder in a dependency-free module prevents the built-in
 * tools from forming an ESM initialization cycle with local-tool-host.
 */
export function defineLocalTool(
  tool: Omit<LocalTool, 'policy' | 'toolKind'> & {
    policy?: LocalTool['policy']
    toolKind?: LocalTool['toolKind']
  }
): LocalTool {
  return {
    policy: tool.policy ?? 'on-request',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    toolKind: tool.toolKind ?? 'tool_call',
    execute: tool.execute,
    ...(tool.effect ? { effect: tool.effect } : {}),
    ...(tool.requireExplicitApproval ? { requireExplicitApproval: true } : {}),
    ...(tool.shouldAdvertise ? { shouldAdvertise: tool.shouldAdvertise } : {})
  }
}
