/**
 * Versioned Stage-A P0 survey-format catalogue.
 *
 * This is the bounded P0 capability policy source. The runtime registry still
 * dispatches detection and parsers, but it must consult this catalogue before
 * assigning a P0 source-file disposition. That keeps an auditable parse from
 * becoming an unsupported adjustment-ready claim.
 */

export const SURVEY_FORMAT_CATALOG_REGISTRY_VERSION = 'workwise-survey-format-catalog-1.7.0' as const

export const P0_SURVEY_FORMAT_IDS = [
  'cosa-in1',
  'cosa-in2',
  'cosa-net',
  'cosa-ou1',
  'cosa-ou2',
  'south-dat',
  'trimble-m5',
  'leica-gsi8',
  'leica-gsi16'
] as const

export type P0SurveyFormatId = (typeof P0_SURVEY_FORMAT_IDS)[number]

/**
 * Explicitly accepted open inputs. These remain outside the bounded D-03
 * vendor P0 catalogue on purpose: their acceptance is governed by a frozen
 * WorkWise schema rather than an instrument-vendor parser claim.
 *
 * CSV/XLSX are intentionally absent: F-FMT-10 requires a saved, user-confirmed
 * column mapping plus linear-unit and angle-format choices. That workflow is
 * not yet wired through the Survey service, so treating a familiar header as
 * adjustment-ready would silently invent those confirmations.
 */
export const ACCEPTED_OPEN_SURVEY_INPUT_FORMAT_IDS = [
  'workwise-json'
] as const

export type AcceptedOpenSurveyInputFormatId = (typeof ACCEPTED_OPEN_SURVEY_INPUT_FORMAT_IDS)[number]

const ACCEPTED_OPEN_SURVEY_INPUT_FORMAT_ID_SET = new Set<string>(ACCEPTED_OPEN_SURVEY_INPUT_FORMAT_IDS)

export function isAcceptedOpenSurveyInputFormat(formatId: string): formatId is AcceptedOpenSurveyInputFormatId {
  return ACCEPTED_OPEN_SURVEY_INPUT_FORMAT_ID_SET.has(formatId)
}

/**
 * Open tables we can retain and inspect, but which must stay archive-only
 * until the F-FMT-10 mapping-confirmation workflow is implemented end-to-end.
 */
export const MAPPING_REQUIRED_OPEN_SURVEY_INPUT_FORMAT_IDS = [
  'delimited-text',
  'xlsx'
] as const

export type MappingRequiredOpenSurveyInputFormatId = (typeof MAPPING_REQUIRED_OPEN_SURVEY_INPUT_FORMAT_IDS)[number]

const MAPPING_REQUIRED_OPEN_SURVEY_INPUT_FORMAT_ID_SET = new Set<string>(MAPPING_REQUIRED_OPEN_SURVEY_INPUT_FORMAT_IDS)

export function isMappingRequiredOpenSurveyInputFormat(formatId: string): formatId is MappingRequiredOpenSurveyInputFormatId {
  return MAPPING_REQUIRED_OPEN_SURVEY_INPUT_FORMAT_ID_SET.has(formatId)
}

/** The four mutually exclusive dispositions established by Stage A. */
export const SURVEY_IMPORT_DISPOSITIONS = [
  'adjustment-ready',
  'gnss-processing-required',
  'converter-required',
  'archive-only'
] as const

export type SurveyImportDisposition = (typeof SURVEY_IMPORT_DISPOSITIONS)[number]

/**
 * The catalogue is deliberately small.  It is a policy directory, not an
 * industry-wide format dump: adding a format requires an explicit,
 * reviewable registration and cannot grow process memory without bound.
 */
export const SURVEY_FORMAT_CATALOG_MAX_ENTRIES = 64 as const

export type SurveyFormatRegistryCatalogEntry = Readonly<{
  registryVersion: string
  formatId: string
  vendor: string
  extensions: readonly string[]
  supportedVersions: readonly string[]
  parserId: string
  parserVersion: string
  supportStatus: string
  supportedDispositions: readonly SurveyImportDisposition[]
  currentDisposition: SurveyImportDisposition
  currentDispositionReason: string
  currentDispositionReasonEn?: string
  fixtureRefs: readonly Readonly<{
    path: string
    kind: string
    provenance: string
  }>[]
}>

export type SurveyFormatRegistryCatalogSnapshot<
  Entry extends SurveyFormatRegistryCatalogEntry = SurveyFormatRegistryCatalogEntry,
  Version extends string = string
> = Readonly<{
  registryVersion: Version
  entries: readonly Entry[]
}>

type SurveyFormatRegistryCatalogInput<
  Entry extends SurveyFormatRegistryCatalogEntry,
  Version extends string
> = Readonly<{
  registryVersion: Version
  entries: readonly Entry[]
  capacity?: number
}>

function requireNonBlank(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Survey format catalogue ${label} must be a non-blank string`)
}

function freezeRegisteredEntry<Entry extends SurveyFormatRegistryCatalogEntry>(input: Entry): Entry {
  return Object.freeze({
    registryVersion: input.registryVersion,
    formatId: input.formatId,
    vendor: input.vendor,
    extensions: Object.freeze([...input.extensions]),
    supportedVersions: Object.freeze([...input.supportedVersions]),
    parserId: input.parserId,
    parserVersion: input.parserVersion,
    supportStatus: input.supportStatus,
    supportedDispositions: Object.freeze([...input.supportedDispositions]),
    currentDisposition: input.currentDisposition,
    currentDispositionReason: input.currentDispositionReason,
    ...(input.currentDispositionReasonEn ? { currentDispositionReasonEn: input.currentDispositionReasonEn } : {}),
    fixtureRefs: Object.freeze(input.fixtureRefs.map((reference) => Object.freeze({
      path: reference.path,
      kind: reference.kind,
      provenance: reference.provenance
    })))
  }) as Entry
}

/**
 * Versioned, bounded directory for parser capabilities.  Registration only
 * records a reviewed policy entry; it does not itself grant an import a more
 * permissive disposition.
 */
export class SurveyFormatRegistryCatalog<
  Entry extends SurveyFormatRegistryCatalogEntry = SurveyFormatRegistryCatalogEntry,
  Version extends string = string
> {
  readonly capacity: number
  private readonly entriesByFormatId = new Map<string, Entry>()

  constructor(input: SurveyFormatRegistryCatalogInput<Entry, Version>) {
    requireNonBlank(input.registryVersion, 'registryVersion')
    if (!Number.isSafeInteger(input.capacity ?? SURVEY_FORMAT_CATALOG_MAX_ENTRIES) || (input.capacity ?? SURVEY_FORMAT_CATALOG_MAX_ENTRIES) < 1) {
      throw new Error('Survey format catalogue capacity must be a positive safe integer')
    }
    if ((input.capacity ?? SURVEY_FORMAT_CATALOG_MAX_ENTRIES) > SURVEY_FORMAT_CATALOG_MAX_ENTRIES) {
      throw new Error(`Survey format catalogue capacity cannot exceed ${SURVEY_FORMAT_CATALOG_MAX_ENTRIES}`)
    }
    if (!Array.isArray(input.entries)) throw new Error('Survey format catalogue entries must be an array')

    this.registryVersion = input.registryVersion
    this.capacity = input.capacity ?? SURVEY_FORMAT_CATALOG_MAX_ENTRIES
    if (input.entries.length > this.capacity) {
      throw new Error(`Survey format catalogue contains ${input.entries.length} entries but capacity is ${this.capacity}`)
    }
    for (const entry of input.entries) this.register(entry)
  }

  readonly registryVersion: Version

  get size(): number {
    return this.entriesByFormatId.size
  }

  register(input: Entry): Entry {
    this.validateEntry(input)
    if (this.entriesByFormatId.has(input.formatId)) {
      throw new Error(`Survey format catalogue already contains formatId ${input.formatId}`)
    }
    if (this.entriesByFormatId.size >= this.capacity) {
      throw new Error(`Survey format catalogue capacity ${this.capacity} has been reached`)
    }
    const entry = freezeRegisteredEntry(input)
    this.entriesByFormatId.set(entry.formatId, entry)
    return entry
  }

  find(formatId: string): Entry | undefined {
    return this.entriesByFormatId.get(formatId)
  }

  snapshot(): SurveyFormatRegistryCatalogSnapshot<Entry, Version> {
    return Object.freeze({
      registryVersion: this.registryVersion,
      entries: Object.freeze([...this.entriesByFormatId.values()])
    })
  }

  private validateEntry(entry: Entry): void {
    if (!entry || typeof entry !== 'object') throw new Error('Survey format catalogue entry must be an object')
    if (entry.registryVersion !== this.registryVersion) {
      throw new Error(`Survey format catalogue entry ${entry.formatId || '(unknown)'} registryVersion must match ${this.registryVersion}`)
    }
    if (typeof entry.formatId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.formatId)) {
      throw new Error('Survey format catalogue formatId must be normalized lowercase kebab-case')
    }
    for (const [label, value] of [
      ['vendor', entry.vendor],
      ['parserId', entry.parserId],
      ['parserVersion', entry.parserVersion],
      ['supportStatus', entry.supportStatus],
      ['currentDispositionReason', entry.currentDispositionReason]
    ] as const) requireNonBlank(value, label)

    if (!Array.isArray(entry.extensions) || !entry.extensions.length) {
      throw new Error(`Survey format catalogue entry ${entry.formatId} must declare at least one extension`)
    }
    const extensions = new Set<string>()
    for (const extension of entry.extensions) {
      if (typeof extension !== 'string' || !/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(extension)) {
        throw new Error(`Survey format catalogue entry ${entry.formatId} has an invalid extension`)
      }
      const normalized = extension.toLowerCase()
      if (extensions.has(normalized)) throw new Error(`Survey format catalogue entry ${entry.formatId} has a duplicate extension ${extension}`)
      extensions.add(normalized)
    }

    if (!Array.isArray(entry.supportedVersions)) throw new Error(`Survey format catalogue entry ${entry.formatId} supportedVersions must be an array`)
    const versions = new Set<string>()
    for (const version of entry.supportedVersions) {
      requireNonBlank(version, `entry ${entry.formatId} supportedVersion`)
      if (versions.has(version)) throw new Error(`Survey format catalogue entry ${entry.formatId} has a duplicate supportedVersion ${version}`)
      versions.add(version)
    }

    if (!Array.isArray(entry.supportedDispositions) || !entry.supportedDispositions.length) {
      throw new Error(`Survey format catalogue entry ${entry.formatId} must declare at least one supported disposition`)
    }
    const dispositions = new Set<SurveyImportDisposition>()
    for (const disposition of entry.supportedDispositions) {
      if (!(SURVEY_IMPORT_DISPOSITIONS as readonly string[]).includes(disposition)) {
        throw new Error(`Survey format catalogue entry ${entry.formatId} has an invalid supported disposition`)
      }
      if (dispositions.has(disposition)) throw new Error(`Survey format catalogue entry ${entry.formatId} has a duplicate supported disposition ${disposition}`)
      dispositions.add(disposition)
    }
    if (!dispositions.has(entry.currentDisposition)) {
      throw new Error(`Survey format catalogue entry ${entry.formatId} currentDisposition must be declared in supportedDispositions`)
    }

    if (!Array.isArray(entry.fixtureRefs)) throw new Error(`Survey format catalogue entry ${entry.formatId} fixtureRefs must be an array`)
    const fixtures = new Set<string>()
    for (const reference of entry.fixtureRefs) {
      if (!reference || typeof reference !== 'object') throw new Error(`Survey format catalogue entry ${entry.formatId} has an invalid fixture reference`)
      requireNonBlank(reference.path, `entry ${entry.formatId} fixture path`)
      requireNonBlank(reference.kind, `entry ${entry.formatId} fixture kind`)
      requireNonBlank(reference.provenance, `entry ${entry.formatId} fixture provenance`)
      const fixtureKey = `${reference.path}\u0000${reference.kind}\u0000${reference.provenance}`
      if (fixtures.has(fixtureKey)) throw new Error(`Survey format catalogue entry ${entry.formatId} has a duplicate fixture reference`)
      fixtures.add(fixtureKey)
    }
  }
}

/** Current evidence state, deliberately separate from the long-term P0 goal. */
export type FormatCatalogSupportStatus =
  | 'parser-core-only'
  | 'planned'
  | 'requires-manual-mapping'

export type FormatFixtureRef = Readonly<{
  path: string
  kind: 'golden' | 'negative'
  provenance: 'synthetic'
}>

export type P0SurveyFormatCatalogEntry = Readonly<{
  registryVersion: typeof SURVEY_FORMAT_CATALOG_REGISTRY_VERSION
  formatId: P0SurveyFormatId
  vendor: 'COSA(科傻)' | 'SOUTH(南方)' | 'Trimble/Zeiss' | 'Leica/Hexagon'
  extensions: readonly string[]
  /**
   * Stable identifiers for accepted vendor versions. `unversioned-text` is
   * explicit for a documented text grammar without an embedded version;
   * an empty list means no authoritative version/column layout is evidenced.
   */
  supportedVersions: readonly string[]
  parserId: string
  parserVersion: string
  supportStatus: FormatCatalogSupportStatus
  /** What the current evidence permits, never an aspirational capability. */
  supportedDispositions: readonly SurveyImportDisposition[]
  currentDisposition: SurveyImportDisposition
  currentDispositionReason: string
  currentDispositionReasonEn?: string
  fixtureRefs: readonly FormatFixtureRef[]
}>

export type P0SurveyFormatCatalog = Readonly<{
  registryVersion: typeof SURVEY_FORMAT_CATALOG_REGISTRY_VERSION
  entries: readonly P0SurveyFormatCatalogEntry[]
}>

function fixture(path: string, kind: FormatFixtureRef['kind']): FormatFixtureRef {
  return Object.freeze({ path, kind, provenance: 'synthetic' })
}

function entry(input: Omit<P0SurveyFormatCatalogEntry, 'registryVersion'>): P0SurveyFormatCatalogEntry {
  return Object.freeze({
    ...input,
    registryVersion: SURVEY_FORMAT_CATALOG_REGISTRY_VERSION,
    extensions: Object.freeze([...input.extensions]),
    supportedVersions: Object.freeze([...input.supportedVersions]),
    supportedDispositions: Object.freeze([...input.supportedDispositions]),
    fixtureRefs: Object.freeze(input.fixtureRefs.map((reference) => Object.freeze({ ...reference })))
  })
}

const COSA_IN2_FIXTURE_REFS = Object.freeze([
  fixture('fixtures/survey-formats/cosa-in2/golden-single-station.in2', 'golden'),
  fixture('fixtures/survey-formats/cosa-in2/golden-multi-station-known-edge.in2', 'golden'),
  fixture('fixtures/survey-formats/cosa-in2/golden-dms-carry-boundary.in2', 'golden'),
  fixture('fixtures/survey-formats/cosa-in2/negative-header-two-fields.in2', 'negative'),
  fixture('fixtures/survey-formats/cosa-in2/negative-missing-backsight-reset.in2', 'negative'),
  fixture('fixtures/survey-formats/cosa-in2/negative-point-name-comma.in2', 'negative'),
  fixture('fixtures/survey-formats/cosa-in2/negative-dms-minutes-60.in2', 'negative'),
  fixture('fixtures/survey-formats/cosa-in2/negative-dms-seconds-60.in2', 'negative')
] as const)

const COSA_IN1_FIXTURE_REFS = Object.freeze([
  fixture('fixtures/survey-formats/professional/cosa-in1-level-golden-a.in1', 'golden'),
  fixture('fixtures/survey-formats/professional/cosa-in1-level-golden-b.in1', 'golden'),
  fixture('fixtures/survey-formats/professional/cosa-in1-level-golden-c.in1', 'golden'),
  fixture('fixtures/survey-formats/professional/cosa-in1-level-negative-no-separator.in1', 'negative'),
  fixture('fixtures/survey-formats/professional/cosa-in1-level-negative-columns.in1', 'negative'),
  fixture('fixtures/survey-formats/professional/cosa-in1-level-negative-distance.in1', 'negative')
] as const)

/**
 * Every entry is intentionally archive-only until its parser, fixtures,
 * provenance, and registry adapter meet the Stage-A gate. Runtime parser
 * output may be retained for audit, but must not override this policy.
 */
const P0_SURVEY_FORMAT_CATALOG_DIRECTORY = new SurveyFormatRegistryCatalog<
  P0SurveyFormatCatalogEntry,
  typeof SURVEY_FORMAT_CATALOG_REGISTRY_VERSION
>({
  registryVersion: SURVEY_FORMAT_CATALOG_REGISTRY_VERSION,
  entries: [
    entry({
      formatId: 'cosa-in1',
      vendor: 'COSA(科傻)',
      extensions: ['.in1'],
      supportedVersions: [],
      parserId: 'cosa-in1-parser',
      parserVersion: '0.1.0',
      supportStatus: 'requires-manual-mapping',
      supportedDispositions: ['adjustment-ready', 'archive-only'],
      currentDisposition: 'adjustment-ready',
      currentDispositionReason: '仅在用户提供并验证显式已知点/测段列映射、m/km 单位声明且严格解析成功时可进入策略校验；缺失或无效映射仍归档。',
      currentDispositionReasonEn: 'Strategy validation requires confirmed known-point/section mappings, explicit m/km units and a successful strict parse. Missing or invalid mappings remain archive-only.',
      fixtureRefs: COSA_IN1_FIXTURE_REFS
    }),
    entry({
      formatId: 'cosa-in2',
      vendor: 'COSA(科傻)',
      extensions: ['.in2'],
      supportedVersions: ['unversioned-text'],
      parserId: 'cosa-in2-parser',
      parserVersion: '0.3.0',
      supportStatus: 'parser-core-only',
      supportedDispositions: ['adjustment-ready', 'archive-only'],
      currentDisposition: 'adjustment-ready',
      currentDispositionReason: '严格结构解析、记录锚点和单位转换成功后可进入策略校验；解析、基准、拓扑、闭合或精度条件不满足时仍会被阻断。',
      currentDispositionReasonEn: 'Strict structure parsing, record anchors and unit conversion permit strategy validation. Parsing, datum, topology, closure or precision failures still block adjustment.',
      fixtureRefs: COSA_IN2_FIXTURE_REFS
    }),
    entry({
      formatId: 'cosa-net',
      vendor: 'COSA(科傻)',
      extensions: ['.NET'],
      supportedVersions: ['unversioned-text'],
      parserId: 'cosa-net-parser',
      parserVersion: '0.1.0',
      supportStatus: 'parser-core-only',
      supportedDispositions: ['archive-only'],
      currentDisposition: 'archive-only',
      currentDispositionReason: '隔离的 .NET 拓扑读取核心仅有 synthetic 证据；registry 尚未具备调用方坐标和文件组来源的接入条件，当前只能归档审查。',
      currentDispositionReasonEn: 'The isolated .NET topology reader has synthetic evidence only. Registry integration with caller coordinates and companion-file provenance is incomplete; archive review only.',
      fixtureRefs: []
    }),
    entry({
      formatId: 'cosa-ou1',
      vendor: 'COSA(科傻)',
      extensions: ['.ou1'],
      supportedVersions: ['unversioned-text'],
      parserId: 'cosa-ou1-read-parser',
      parserVersion: '0.0.0',
      supportStatus: 'planned',
      supportedDispositions: ['archive-only'],
      currentDisposition: 'archive-only',
      currentDispositionReason: 'Read-only result comparison fields are planned; no accepted parser/fixture evidence is registered yet.',
      currentDispositionReasonEn: 'Read-only result comparison fields are planned; no accepted parser/fixture evidence is registered yet.',
      fixtureRefs: []
    }),
    entry({
      formatId: 'cosa-ou2',
      vendor: 'COSA(科傻)',
      extensions: ['.ou2'],
      supportedVersions: ['unversioned-text'],
      parserId: 'cosa-ou2-read-parser',
      parserVersion: '0.0.0',
      supportStatus: 'planned',
      supportedDispositions: ['archive-only'],
      currentDisposition: 'archive-only',
      currentDispositionReason: 'Read-only result comparison fields are planned; no accepted parser/fixture evidence is registered yet.',
      currentDispositionReasonEn: 'Read-only result comparison fields are planned; no accepted parser/fixture evidence is registered yet.',
      fixtureRefs: []
    }),
    entry({
      formatId: 'south-dat',
      vendor: 'SOUTH(南方)',
      extensions: ['.dat'],
      supportedVersions: [],
      parserId: 'south-dat-column-mapping-parser',
      parserVersion: '0.1.0',
      supportStatus: 'requires-manual-mapping',
      supportedDispositions: ['archive-only'],
      currentDisposition: 'archive-only',
      currentDispositionReason: 'Authoritative DAT column order is n.a.; no default mapping may be guessed and unmapped files are archive-only.',
      currentDispositionReasonEn: 'Authoritative DAT column order is n.a.; no default mapping may be guessed and unmapped files are archive-only.',
      fixtureRefs: [
        fixture('kun/src/engineering/fixtures/survey-formats/professional/south-dat-explicit.dat', 'golden'),
        fixture('kun/src/engineering/fixtures/survey-formats/professional/south-dat-negative.dat', 'negative')
      ]
    }),
    entry({
      formatId: 'trimble-m5',
      vendor: 'Trimble/Zeiss',
      extensions: ['.m5', '.dat'],
      supportedVersions: ['aBFFB'],
      parserId: 'trimble-m5-abffb-parser',
      parserVersion: '0.2.0',
      supportStatus: 'parser-core-only',
      supportedDispositions: ['adjustment-ready', 'archive-only'],
      currentDisposition: 'adjustment-ready',
      currentDispositionReason: '严格识别 For M5 aBFFB 测段、Rb/Rf 顺序、米制读数和原始记录锚点后可进入策略校验；已知高程基准、闭合、拓扑和精度条件仍由平差入口逐项验证。',
      currentDispositionReasonEn: 'Strict For M5 aBFFB section recognition, Rb/Rf order, metre readings and raw-record anchors permit strategy validation. Known height datum, closure, topology and precision are checked at adjustment entry.',
      fixtureRefs: [
        fixture('kun/src/engineering/fixtures/survey-formats/professional/trimble-m5.m5', 'golden'),
        fixture('kun/src/engineering/fixtures/survey-formats/professional/trimble-m5-dat.dat', 'golden'),
        fixture('kun/src/engineering/fixtures/survey-formats/professional/trimble-m5-negative.m5', 'negative'),
        fixture('kun/src/engineering/fixtures/survey-formats/professional/trimble-m5-dat-negative.dat', 'negative')
      ]
    }),
    entry({
      formatId: 'leica-gsi8',
      vendor: 'Leica/Hexagon',
      extensions: ['.gsi'],
      supportedVersions: ['GSI8'],
      parserId: 'leica-gsi8-parser',
      parserVersion: '0.1.0',
      supportStatus: 'parser-core-only',
      supportedDispositions: ['adjustment-ready', 'archive-only'],
      currentDisposition: 'adjustment-ready',
      currentDispositionReason: '词法、观测语义和单位转换成功后可进入策略校验；固定控制、基准、几何、闭合和精度条件仍由平差入口逐项验证。',
      currentDispositionReasonEn: 'Validated lexical structure, observation semantics and unit conversion permit strategy validation. Fixed control, datum, geometry, closure and precision are still checked at adjustment entry.',
      fixtureRefs: [
        fixture('fixtures/survey-formats/professional/leica-gsi8.gsi', 'golden'),
        fixture('fixtures/survey-formats/professional/leica-gsi-negative.gsi', 'negative')
      ]
    }),
    entry({
      formatId: 'leica-gsi16',
      vendor: 'Leica/Hexagon',
      extensions: ['.gsi'],
      supportedVersions: ['GSI16'],
      parserId: 'leica-gsi16-parser',
      parserVersion: '0.1.0',
      supportStatus: 'parser-core-only',
      supportedDispositions: ['adjustment-ready', 'archive-only'],
      currentDisposition: 'adjustment-ready',
      currentDispositionReason: '词法、观测语义和单位转换成功后可进入策略校验；固定控制、基准、几何、闭合和精度条件仍由平差入口逐项验证。',
      currentDispositionReasonEn: 'Validated lexical structure, observation semantics and unit conversion permit strategy validation. Fixed control, datum, geometry, closure and precision are still checked at adjustment entry.',
      fixtureRefs: [
        fixture('fixtures/survey-formats/professional/leica-gsi16.gsi', 'golden'),
        fixture('fixtures/survey-formats/professional/leica-gsi-negative.gsi', 'negative')
      ]
    })
  ]
})

/** Immutable audited view consumed by the runtime policy adapter. */
export const P0_SURVEY_FORMAT_CATALOG: P0SurveyFormatCatalog = P0_SURVEY_FORMAT_CATALOG_DIRECTORY.snapshot()

const P0_ENTRIES_BY_ID = new Map<P0SurveyFormatId, P0SurveyFormatCatalogEntry>(
  P0_SURVEY_FORMAT_CATALOG.entries.map((catalogEntry) => [catalogEntry.formatId, catalogEntry])
)

/** Returns the bounded P0 entry; absent formats are intentionally not inferred. */
export function findP0SurveyFormatEntry(formatId: string): P0SurveyFormatCatalogEntry | undefined {
  return P0_ENTRIES_BY_ID.get(formatId as P0SurveyFormatId)
}

/** The catalogue-level no-fallback rule: unknown formats can only be archived. */
export function catalogDispositionFor(formatId: string): SurveyImportDisposition {
  return findP0SurveyFormatEntry(formatId)?.currentDisposition ?? 'archive-only'
}
