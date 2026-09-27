import { createHash, X509Certificate } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Session } from 'electron'

export type PrivateUpdaterTlsInput = { certificateSha256: string; sourceHead: string }
export type PrivateUpdaterTlsPolicy = { certificateSha256: string; feedUrl: string }
let activePolicy: PrivateUpdaterTlsPolicy | undefined

export function validatePrivateUpdaterTls(
  input: PrivateUpdaterTlsInput,
  feedUrl: string,
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env,
  executable = process.execPath
): PrivateUpdaterTlsPolicy {
  const feed = new URL(feedUrl)
  if (process.platform !== 'darwin' || !/^[a-f0-9]{64}$/.test(input.certificateSha256) || !/^[a-f0-9]{40}$/.test(input.sourceHead)
    || feed.protocol !== 'https:' || feed.hostname !== '127.0.0.1' || !feed.port
    || feed.username || feed.password || feed.search || feed.hash
    || !/^\/private-[a-f0-9]{64}\/$/.test(feed.pathname)
    || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'macOS' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.WORKWISE_CANDIDATE !== '1' || env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED !== '1'
    || env.WORKWISE_CANDIDATE_INBOUND_DISABLED !== '1' || env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS !== '0'
    || !env.RUNNER_TEMP || !env.WORKWISE_CANDIDATE_ROOT) {
    throw new Error('Private updater certificate pin requires an isolated hosted candidate acceptance run.')
  }
  const root = realpathSync(env.WORKWISE_CANDIDATE_ROOT)
  const name = `RailWise AI Candidate ${input.sourceHead.slice(0, 12)}`
  if (dirname(root) !== realpathSync(env.RUNNER_TEMP) || !/\/workwise-private-updater-[A-Za-z0-9]+$/.test(root)
    || realpathSync(userDataPath) !== join(root, 'user-data')
    || realpathSync(executable) !== join(root, 'Applications', `${name}.app`, 'Contents/MacOS', name)) {
    throw new Error('Private updater certificate pin does not match the installed isolated candidate.')
  }
  return { certificateSha256: input.certificateSha256, feedUrl: feed.href }
}

export function activatePrivateUpdaterTls(policy: PrivateUpdaterTlsPolicy): void {
  activePolicy = policy
}

export function privateUpdaterRequestAllowed(policy: PrivateUpdaterTlsPolicy, url: string): boolean {
  try {
    const request = new URL(url)
    const feed = new URL(policy.feedUrl)
    return request.origin === feed.origin && !request.username && !request.password
      && request.pathname.startsWith(feed.pathname)
  } catch { return false }
}

export function privateUpdaterCertificateResult(
  policy: PrivateUpdaterTlsPolicy,
  request: { hostname: string; certificate: { data: string } },
  now = Date.now()
): number {
  if (request.hostname !== '127.0.0.1') return -2
  try {
    const certificate = new X509Certificate(request.certificate.data)
    return createHash('sha256').update(certificate.raw).digest('hex') === policy.certificateSha256
      && certificate.checkIP('127.0.0.1') === '127.0.0.1'
      && now >= Date.parse(certificate.validFrom) && now <= Date.parse(certificate.validTo)
      ? 0 : -2
  } catch { return -2 }
}

export function installPrivateUpdaterTls(session: Session, policy: PrivateUpdaterTlsPolicy): void {
  // The verifier has no port field. The request guard binds every request and
  // redirect to this run's exact HTTPS origin and unguessable private path.
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !privateUpdaterRequestAllowed(policy, details.url) })
  })
  session.setCertificateVerifyProc((request, callback) => {
    callback(privateUpdaterCertificateResult(policy, request))
  })
}

let configuredSession: Session | undefined
export function configurePrivateUpdaterTls(getSession: () => Session, feedUrl: string): void {
  if (!activePolicy) return
  if (feedUrl !== activePolicy.feedUrl) throw new Error('Private updater cannot change its pinned feed.')
  const session = getSession()
  if (configuredSession === session) return
  installPrivateUpdaterTls(session, activePolicy)
  configuredSession = session
}
