import type { McpServerConfigV2 } from './agent-workbench'

export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'
export const GITHUB_MCP_READONLY_URL = 'https://api.githubcopilot.com/mcp/readonly'
export const GITHUB_TOKEN_CREATE_URL = 'https://github.com/settings/personal-access-tokens/new'
export const GITHUB_TOKEN_GUIDE_URL = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens'
export const GITHUB_MCP_AUTH_GUIDE_URL = 'https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md'

/** Limit the native token entry to GitHub's actual hosted MCP origin. */
export function isGitHubMcpServer(server: Pick<McpServerConfigV2, 'transport' | 'url'>): boolean {
  if (server.transport !== 'http' || !server.url) return false
  try {
    const url = new URL(server.url)
    return url.origin === 'https://api.githubcopilot.com' && url.pathname.startsWith('/mcp/')
      && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

export function githubMcpMode(server?: Pick<McpServerConfigV2, 'url'>): 'readonly' | 'token' {
  return !server || /\/readonly(?:\/|$)/.test(server.url ?? '') ? 'readonly' : 'token'
}
