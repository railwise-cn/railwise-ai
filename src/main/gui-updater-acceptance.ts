import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { activatePrivateUpdaterTls, validatePrivateUpdaterTls, type PrivateUpdaterTlsInput } from './private-updater-tls'
import type {
  GuiUpdateChannel,
  GuiUpdateDownloadResult,
  GuiUpdateInfo,
  GuiUpdateInstallResult
} from '../shared/gui-update'

const ACCEPTANCE_ARG = '--workwise-updater-acceptance='
const STATE_FILE = 'updater-acceptance-state.json'
const USER_DATA_PROBE_FILE = 'updater-acceptance-user-data-probe.json'

type AcceptanceStageName =
  | 'base_started'
  | 'update_available'
  | 'download_completed'
  | 'install_requested'
  | 'target_relaunched'
  | 'user_data_preserved'

type AcceptanceStage = {
  name: AcceptanceStageName
  at: string
  detail?: string
}

export type GuiUpdaterAcceptanceReport = {
  schemaVersion: 1
  status: 'running' | 'passed' | 'failed'
  platform: NodeJS.Platform
  arch: string
  baseVersion: string
  targetVersion: string
  channel: GuiUpdateChannel
  feedUrl: string
  startedAt: string
  completedAt?: string
  failure?: string
  browserOpened: false
  userDataPreserved: boolean
  stages: AcceptanceStage[]
}

type AcceptanceInput = {
  schemaVersion: 1
  baseVersion: string
  targetVersion: string
  channel: GuiUpdateChannel
  feedUrl: string
  reportPath: string
  privateTls?: PrivateUpdaterTlsInput
}

type AcceptanceState = AcceptanceInput & {
  phase: 'checking' | 'installing'
  probeRequired?: boolean
  probe?: AcceptanceProbe
  report: GuiUpdaterAcceptanceReport
}

type AcceptanceProbe = {
  schemaVersion: 1
  nonce: string
  baseVersion: string
  createdAt: string
}

export type ActiveGuiUpdaterAcceptance = {
  kind: 'active'
  statePath: string
  probePath: string
  reportPath: string
  state: AcceptanceState
}

export type TerminalGuiUpdaterAcceptance = {
  kind: 'terminal'
  reportPath: string
  report: GuiUpdaterAcceptanceReport
}

export type GuiUpdaterAcceptance = ActiveGuiUpdaterAcceptance | TerminalGuiUpdaterAcceptance

export function isGuiUpdaterAcceptanceLaunch(argv: string[], userDataPath: string): boolean {
  return argv.some((argument) => argument.startsWith(ACCEPTANCE_ARG)) ||
    existsSync(join(userDataPath, STATE_FILE))
}

type PrepareOptions = {
  argv: string[]
  userDataPath: string
  currentVersion: string
  platform?: NodeJS.Platform
  arch?: string
  now?: () => string
  nonce?: () => string
}

type UpdaterApi = {
  checkGuiUpdate(channel: GuiUpdateChannel): Promise<GuiUpdateInfo>
  downloadGuiUpdate(channel: GuiUpdateChannel): Promise<GuiUpdateDownloadResult>
  installGuiUpdate(): Promise<GuiUpdateInstallResult>
}

function semver(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.trim())) {
    throw new Error(`${label} must be an x.y.z version.`)
  }
  return value.trim()
}

function parseInput(value: unknown): AcceptanceInput {
  if (!value || typeof value !== 'object') throw new Error('Updater acceptance config must be an object.')
  const input = value as Partial<AcceptanceInput>
  if (input.schemaVersion !== 1) throw new Error('Updater acceptance config schemaVersion must be 1.')
  const baseVersion = semver(input.baseVersion, 'baseVersion')
  const targetVersion = semver(input.targetVersion, 'targetVersion')
  if (baseVersion === targetVersion) throw new Error('targetVersion must differ from baseVersion.')
  if (input.channel !== 'stable' && input.channel !== 'frontier') {
    throw new Error('channel must be stable or frontier.')
  }
  if (typeof input.feedUrl !== 'string' || !/^https:\/\//i.test(input.feedUrl.trim())) {
    throw new Error('feedUrl must use HTTPS.')
  }
  if (typeof input.reportPath !== 'string' || !isAbsolute(input.reportPath)) {
    throw new Error('reportPath must be absolute.')
  }
  if (input.privateTls !== undefined && (!input.privateTls || typeof input.privateTls !== 'object'
    || typeof input.privateTls.certificateSha256 !== 'string' || typeof input.privateTls.sourceHead !== 'string')) {
    throw new Error('Invalid private updater TLS configuration.')
  }
  return {
    schemaVersion: 1,
    baseVersion,
    targetVersion,
    channel: input.channel,
    feedUrl: `${input.feedUrl.trim().replace(/\/+$/, '')}/`,
    reportPath: input.reportPath,
    ...(input.privateTls ? { privateTls: input.privateTls } : {})
  }
}

function parseProbe(value: unknown): AcceptanceProbe {
  if (!value || typeof value !== 'object') throw new Error('User data probe must be an object.')
  const probe = value as Partial<AcceptanceProbe>
  if (probe.schemaVersion !== 1) throw new Error('User data probe schemaVersion must be 1.')
  if (typeof probe.nonce !== 'string' || !/^[0-9a-f-]{16,}$/i.test(probe.nonce)) {
    throw new Error('User data probe nonce is invalid.')
  }
  const baseVersion = semver(probe.baseVersion, 'User data probe baseVersion')
  if (typeof probe.createdAt !== 'string' || !Number.isFinite(Date.parse(probe.createdAt))) {
    throw new Error('User data probe createdAt is invalid.')
  }
  return {
    schemaVersion: 1,
    nonce: probe.nonce,
    baseVersion,
    createdAt: probe.createdAt
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function stage(report: GuiUpdaterAcceptanceReport, name: AcceptanceStageName, at: string, detail?: string): void {
  report.stages.push({ name, at, ...(detail ? { detail } : {}) })
}

async function persistActive(acceptance: ActiveGuiUpdaterAcceptance): Promise<void> {
  await writeJsonAtomic(acceptance.statePath, acceptance.state)
  await writeJsonAtomic(acceptance.reportPath, acceptance.state.report)
}

async function failActive(
  acceptance: ActiveGuiUpdaterAcceptance,
  error: unknown,
  now: () => string
): Promise<TerminalGuiUpdaterAcceptance> {
  const message = error instanceof Error ? error.message : String(error)
  acceptance.state.report.status = 'failed'
  acceptance.state.report.failure = message
  acceptance.state.report.completedAt = now()
  try {
    await writeJsonAtomic(acceptance.reportPath, acceptance.state.report)
  } finally {
    await Promise.all([
      unlink(acceptance.statePath).catch(() => undefined),
      unlink(acceptance.probePath).catch(() => undefined)
    ])
  }
  return { kind: 'terminal', reportPath: acceptance.reportPath, report: acceptance.state.report }
}

export function configureGuiUpdaterAcceptance(acceptance: ActiveGuiUpdaterAcceptance): void {
  if (acceptance.state.privateTls) {
    activatePrivateUpdaterTls(validatePrivateUpdaterTls(
      acceptance.state.privateTls, acceptance.state.feedUrl, dirname(acceptance.statePath)
    ))
  }
  process.env.WORKWISE_UPDATE_PROVIDER = 'generic'
  process.env.WORKWISE_UPDATE_URL = acceptance.state.feedUrl
  process.env.WORKWISE_UPDATE_CHANNEL = acceptance.state.channel
}

export async function prepareGuiUpdaterAcceptance(
  options: PrepareOptions
): Promise<GuiUpdaterAcceptance | null> {
  const now = options.now ?? (() => new Date().toISOString())
  const statePath = join(options.userDataPath, STATE_FILE)
  const probePath = join(options.userDataPath, USER_DATA_PROBE_FILE)
  const configArgument = options.argv.find((argument) => argument.startsWith(ACCEPTANCE_ARG))

  if (configArgument) {
    const configPath = configArgument.slice(ACCEPTANCE_ARG.length)
    if (!isAbsolute(configPath)) throw new Error('Updater acceptance config path must be absolute.')
    const input = parseInput(await readJson(configPath))
    if (options.currentVersion !== input.baseVersion) {
      throw new Error(`Updater acceptance expected base ${input.baseVersion}, got ${options.currentVersion}.`)
    }
    const startedAt = now()
    const probe: AcceptanceProbe = {
      schemaVersion: 1,
      nonce: (options.nonce ?? randomUUID)(),
      baseVersion: input.baseVersion,
      createdAt: startedAt
    }
    const report: GuiUpdaterAcceptanceReport = {
      schemaVersion: 1,
      status: 'running',
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      baseVersion: input.baseVersion,
      targetVersion: input.targetVersion,
      channel: input.channel,
      feedUrl: input.feedUrl,
      startedAt,
      browserOpened: false,
      userDataPreserved: false,
      stages: [{ name: 'base_started', at: startedAt }]
    }
    const acceptance: ActiveGuiUpdaterAcceptance = {
      kind: 'active',
      statePath,
      probePath,
      reportPath: input.reportPath,
      state: { ...input, phase: 'checking', probeRequired: true, probe, report }
    }
    try {
      await writeJsonAtomic(probePath, probe)
      await persistActive(acceptance)
    } catch (error) {
      await Promise.all([
        unlink(statePath).catch(() => undefined),
        unlink(probePath).catch(() => undefined)
      ])
      throw error
    }
    return acceptance
  }

  let state: AcceptanceState
  let input: AcceptanceInput
  try {
    state = (await readJson(statePath)) as AcceptanceState
    input = parseInput(state)
  } catch {
    await Promise.all([
      unlink(statePath).catch(() => undefined),
      unlink(probePath).catch(() => undefined)
    ])
    return null
  }
  const acceptance: ActiveGuiUpdaterAcceptance = {
    kind: 'active',
    statePath,
    probePath,
    reportPath: input.reportPath,
    state: { ...state, ...input }
  }
  if (state.phase !== 'installing') {
    return failActive(acceptance, 'Updater acceptance restarted before installation was requested.', now)
  }
  if (options.currentVersion !== input.targetVersion) {
    return failActive(
      acceptance,
      `Platform updater relaunched version ${options.currentVersion}; expected ${input.targetVersion}.`,
      now
    )
  }

  stage(acceptance.state.report, 'target_relaunched', now(), options.currentVersion)

  // Releases before the nonce probe was introduced cannot retroactively create
  // the new probe. Their installing state is still an independent user-data
  // continuity record, so accept that legacy shape after validating its phase
  // and version identity. New states remain fail-closed on probe corruption.
  const strictProbe = acceptance.state.probeRequired === true || acceptance.state.probe !== undefined
  let preservationDetail = acceptance.state.baseVersion
  if (strictProbe) {
    let expectedProbe: AcceptanceProbe
    try {
      expectedProbe = parseProbe(acceptance.state.probe)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return failActive(acceptance, `User data preservation probe is missing or invalid: ${detail}`, now)
    }
    let persistedProbe: AcceptanceProbe
    try {
      persistedProbe = parseProbe(await readJson(probePath))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return failActive(acceptance, `User data preservation probe is missing or invalid: ${detail}`, now)
    }
    if (
      persistedProbe.nonce !== expectedProbe.nonce ||
      persistedProbe.baseVersion !== expectedProbe.baseVersion ||
      persistedProbe.createdAt !== expectedProbe.createdAt
    ) {
      return failActive(acceptance, 'User data preservation probe does not match the baseline installation.', now)
    }
    preservationDetail = persistedProbe.baseVersion
  } else {
    const report = acceptance.state.report
    const stageNames = report.stages.map((item) => item.name)
    if (
      report.status !== 'running' ||
      report.baseVersion !== acceptance.state.baseVersion ||
      report.targetVersion !== acceptance.state.targetVersion ||
      JSON.stringify(stageNames) !== JSON.stringify([
        'base_started',
        'update_available',
        'download_completed',
        'install_requested',
        'target_relaunched'
      ])
    ) {
      return failActive(acceptance, 'Legacy updater acceptance state is incomplete or inconsistent.', now)
    }
    preservationDetail = `legacy-state:${acceptance.state.baseVersion}`
  }
  acceptance.state.report.userDataPreserved = true
  stage(acceptance.state.report, 'user_data_preserved', now(), preservationDetail)
  acceptance.state.report.status = 'passed'
  acceptance.state.report.completedAt = now()
  try {
    await writeJsonAtomic(acceptance.reportPath, acceptance.state.report)
  } finally {
    await Promise.all([
      unlink(statePath).catch(() => undefined),
      unlink(probePath).catch(() => undefined)
    ])
  }
  return { kind: 'terminal', reportPath: acceptance.reportPath, report: acceptance.state.report }
}

export async function failGuiUpdaterAcceptance(
  acceptance: ActiveGuiUpdaterAcceptance,
  error: unknown,
  now: () => string = () => new Date().toISOString()
): Promise<TerminalGuiUpdaterAcceptance> {
  return failActive(acceptance, error, now)
}

export async function runGuiUpdaterAcceptance(
  acceptance: ActiveGuiUpdaterAcceptance,
  updater: UpdaterApi,
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  try {
    const checked = await updater.checkGuiUpdate(acceptance.state.channel)
    if (!checked.ok) throw new Error(`Update check failed: ${checked.message}`)
    if (!checked.hasUpdate) throw new Error('Update check did not find a newer version.')
    if (checked.manualOnly) throw new Error('Update source was available only as a manual download.')
    if (checked.currentVersion !== acceptance.state.baseVersion) {
      throw new Error(`Updater reported base ${checked.currentVersion}; expected ${acceptance.state.baseVersion}.`)
    }
    if (checked.latestVersion !== acceptance.state.targetVersion) {
      throw new Error(`Updater reported target ${checked.latestVersion}; expected ${acceptance.state.targetVersion}.`)
    }
    stage(acceptance.state.report, 'update_available', now(), checked.latestVersion)
    await persistActive(acceptance)

    const downloaded = await updater.downloadGuiUpdate(acceptance.state.channel)
    if (!downloaded.ok) throw new Error(`Update download failed: ${downloaded.message}`)
    stage(acceptance.state.report, 'download_completed', now(), `${downloaded.paths.length} artifact(s)`)
    await persistActive(acceptance)

    acceptance.state.phase = 'installing'
    stage(acceptance.state.report, 'install_requested', now())
    await persistActive(acceptance)
    const installed = await updater.installGuiUpdate()
    if (!installed.ok) throw new Error(`Update install failed: ${installed.message}`)
  } catch (error) {
    await failActive(acceptance, error, now)
  }
}

export const _internals = { parseInput, parseProbe, STATE_FILE, USER_DATA_PROBE_FILE, ACCEPTANCE_ARG }
