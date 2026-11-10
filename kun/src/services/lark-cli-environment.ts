import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

function contained(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== '' && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
}

function resolveExistingAncestors(path: string): string {
  let ancestor = path
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('Candidate CLI configuration directory could not be resolved.')
    ancestor = parent
  }
  return resolve(realpathSync(ancestor), relative(ancestor, path))
}

/** Shared by the main-process login flow and every Runtime CLI invocation. */
export function resolveLarkCliEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.WORKWISE_CANDIDATE !== '1') return { ...env }
  const root = env.WORKWISE_CANDIDATE_ROOT
  const home = env.WORKWISE_CANDIDATE_HOME || (root ? join(root, 'home') : undefined)
  const configDir = home ? join(resolve(home), '.lark-cli') : undefined
  if (!root || !home || !isAbsolute(root) || !isAbsolute(home) || !contained(resolve(root), resolve(home)) ||
      !contained(resolveExistingAncestors(resolve(root)), resolveExistingAncestors(resolve(home))) ||
      !configDir || !contained(resolveExistingAncestors(resolve(root)), resolveExistingAncestors(configDir))) {
    throw Object.assign(new Error('Candidate CLI configuration must stay inside its isolated root.'), { code: 'candidate_configuration_blocked' })
  }
  return { ...env, LARKSUITE_CLI_CONFIG_DIR: configDir }
}

/** Check at dispatch as well as diagnosis, including readonly recovery tools. */
export function assertLarkCliCredentialAccess(env: NodeJS.ProcessEnv = process.env): void {
  if (env.WORKWISE_CANDIDATE === '1' && env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS !== '1') {
    throw Object.assign(new Error('Candidate credential access is disabled. No Lark account or Keychain was read.'), { code: 'candidate_credentials_disabled' })
  }
}
