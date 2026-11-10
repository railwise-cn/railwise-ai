import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return Boolean(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
}
function canonical(path: string): string {
  let ancestor = path
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('DingTalk configuration directory could not be resolved.')
    ancestor = parent
  }
  return resolve(realpathSync(ancestor), relative(ancestor, path))
}

/** Managed DWS never reads ~/.dws, shell-injected tokens or the system Keychain. */
export function resolveDwsEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let root = join(resolve(env.WORKWISE_TOOLS_ROOT || join(homedir(), '.workwise', 'tools')), 'dws-state')
  if (env.WORKWISE_CANDIDATE === '1') {
    const candidateRoot = env.WORKWISE_CANDIDATE_ROOT
    const home = env.WORKWISE_CANDIDATE_HOME || (candidateRoot ? join(candidateRoot, 'home') : undefined)
    if (!candidateRoot || !home || !isAbsolute(candidateRoot) || !isAbsolute(home) ||
      !inside(resolve(candidateRoot), resolve(home)) || !inside(canonical(resolve(candidateRoot)), canonical(resolve(home)))) {
      throw Object.assign(new Error('Candidate DingTalk configuration must stay inside its isolated root.'), { code: 'candidate_configuration_blocked' })
    }
    root = join(resolve(home), '.railwise-dws')
    if (!inside(canonical(resolve(candidateRoot)), canonical(root))) throw new Error('Candidate DingTalk configuration escapes its isolated root.')
  }
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('DWS_')))
  return { ...clean, DWS_CONFIG_DIR: join(root, 'config'), DWS_KEYCHAIN_DIR: join(root, 'keychain'), DWS_DISABLE_KEYCHAIN: '1', DWS_LANG: 'zh' }
}

export function assertDwsCredentialAccess(env: NodeJS.ProcessEnv = process.env): void {
  if (env.WORKWISE_CANDIDATE === '1' && env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS !== '1') {
    throw Object.assign(new Error('Candidate credential access is disabled. No DingTalk account or Keychain was read.'), { code: 'candidate_credentials_disabled' })
  }
}
