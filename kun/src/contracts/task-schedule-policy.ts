/** These legacy bridges remain available outside task executions. Tasks use
 * their native schedule_task authority, never either compatibility MCP server.
 */
export function isTaskScheduleBridgeServer(serverId: string): boolean {
  return serverId === 'gui_schedule' || serverId === 'claw_schedule'
}

export function isTaskScheduleBridgeProvider(providerId: string): boolean {
  return providerId === 'mcp:gui_schedule' || providerId === 'mcp:claw_schedule'
}

/** Preserve every retained value and malformed input verbatim. Only the two
 * already task-forbidden identities are irrelevant to effective task scope.
 */
export function taskScheduleConnectorIdentities<T>(identities: T): T {
  if (!identities || typeof identities !== 'object' || Array.isArray(identities)) return identities
  return Object.fromEntries(Object.entries(identities).filter(([id]) => !isTaskScheduleBridgeProvider(id))) as T
}
