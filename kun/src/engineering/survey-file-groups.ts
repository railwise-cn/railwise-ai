/**
 * Pure COSA companion-file grouping.
 *
 * The caller supplies a bounded, already-selected list of file descriptors.
 * This module never reads a directory, opens a file, or inspects content: it
 * only makes the filename relationship explicit so a later import flow can
 * present the association for review.
 */

export type SurveyFileDescriptor = Readonly<{
  /** Caller-provided display name or logical relative path; never dereferenced here. */
  name: string
  sha256: string
  size: number
}>

export const COSA_FILE_GROUP_MEMBER_KINDS = ['in1', 'in2', 'net', 'xyo', 'ou1', 'ou2'] as const
export type CosaFileGroupMemberKind = (typeof COSA_FILE_GROUP_MEMBER_KINDS)[number]

/**
 * Filename-level roles only. They describe how same-stem files may be
 * associated for review; they do not assert that any byte-level contents have
 * been parsed or are eligible for adjustment.
 */
export const COSA_FILE_GROUP_MEMBER_ROLE_BY_KIND = Object.freeze({
  in1: 'height-observation-input',
  in2: 'plane-observation-input',
  net: 'plane-topology-companion',
  xyo: 'plane-coordinate-companion',
  ou1: 'height-result-comparison',
  ou2: 'plane-result-comparison'
} as const)
export type CosaFileGroupMemberRole = (typeof COSA_FILE_GROUP_MEMBER_ROLE_BY_KIND)[CosaFileGroupMemberKind]

/** A companion/result may only be associated when its source input is present. */
export const COSA_FILE_GROUP_REQUIRED_PRIMARY_BY_MEMBER_KIND = Object.freeze({
  in1: null,
  in2: null,
  net: 'in2',
  xyo: 'in2',
  ou1: 'in1',
  ou2: 'in2'
} as const)

export type CosaFileGroupMembers = Readonly<{
  in1: readonly SurveyFileDescriptor[]
  in2: readonly SurveyFileDescriptor[]
  net: readonly SurveyFileDescriptor[]
  xyo: readonly SurveyFileDescriptor[]
  ou1: readonly SurveyFileDescriptor[]
  ou2: readonly SurveyFileDescriptor[]
}>

export type CosaFileGroupDiagnostic = Readonly<{
  code: 'cosa_orphan_auxiliary' | 'cosa_orphan_result' | 'cosa_duplicate_member'
  severity: 'blocking'
  message: string
  localized?: { en: { message: string; suggestedAction: string } }
  suggestedAction: string
  groupId: string
  memberKind: CosaFileGroupMemberKind
  /** The matching source input required to associate an orphaned file. */
  requiredPrimaryMemberKind?: 'in1' | 'in2'
  files: readonly SurveyFileDescriptor[]
}>

export type CosaFileGroup = Readonly<{
  /** Stable logical key, derived only from the normalized caller-supplied name. */
  id: string
  family: 'cosa'
  /** Case-normalized stem, excluding the final COSA member suffix. */
  normalizedStem: string
  /** Case-normalized logical directory, if the caller included one in `name`. */
  normalizedDirectory: string
  members: CosaFileGroupMembers
  /** Stable filename roles; never a statement about parsed source semantics. */
  memberRoles: Readonly<Record<CosaFileGroupMemberKind, CosaFileGroupMemberRole>>
  state: 'ready' | 'blocked'
  diagnostics: readonly CosaFileGroupDiagnostic[]
}>

export type CosaFileGroupResult = Readonly<{
  groups: readonly CosaFileGroup[]
  diagnostics: readonly CosaFileGroupDiagnostic[]
}>

type Candidate = Readonly<{
  descriptor: SurveyFileDescriptor
  memberKind: CosaFileGroupMemberKind
  normalizedDirectory: string
  normalizedStem: string
  groupKey: string
}>

type MutableGroup = {
  normalizedDirectory: string
  normalizedStem: string
  members: Record<CosaFileGroupMemberKind, SurveyFileDescriptor[]>
}

const MEMBER_KIND_BY_EXTENSION: Readonly<Record<string, CosaFileGroupMemberKind>> = Object.freeze({
  '.in1': 'in1',
  '.in2': 'in2',
  '.net': 'net',
  '.xyo': 'xyo',
  '.ou1': 'ou1',
  '.ou2': 'ou2'
})

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareDescriptors(left: SurveyFileDescriptor, right: SurveyFileDescriptor): number {
  return compareText(left.name.toLowerCase(), right.name.toLowerCase())
    || compareText(left.name, right.name)
    || compareText(left.sha256, right.sha256)
    || left.size - right.size
}

function snapshot(descriptor: SurveyFileDescriptor): SurveyFileDescriptor {
  return Object.freeze({
    name: descriptor.name,
    sha256: descriptor.sha256,
    size: descriptor.size
  })
}

function candidateFor(descriptor: SurveyFileDescriptor): Candidate | null {
  // A path-like `name` is only a caller label. Replacing separators avoids
  // case/path presentation differences changing the logical group, without
  // resolving it against the machine filesystem.
  const logicalName = descriptor.name.trim().replaceAll('\\', '/')
  const separator = logicalName.lastIndexOf('/')
  const directory = separator < 0 ? '' : logicalName.slice(0, separator)
  const baseName = separator < 0 ? logicalName : logicalName.slice(separator + 1)
  const extensionOffset = baseName.lastIndexOf('.')
  if (extensionOffset <= 0 || extensionOffset === baseName.length - 1) return null

  const memberKind = MEMBER_KIND_BY_EXTENSION[baseName.slice(extensionOffset).toLowerCase()]
  if (!memberKind) return null

  const normalizedStem = baseName.slice(0, extensionOffset).trim().toLowerCase()
  if (!normalizedStem) return null
  const normalizedDirectory = directory.trim().toLowerCase()
  // JSON encoding preserves the directory/stem boundary without treating the
  // values as a filesystem path.
  const groupKey = JSON.stringify([normalizedDirectory, normalizedStem])

  return Object.freeze({
    descriptor: snapshot(descriptor),
    memberKind,
    normalizedDirectory,
    normalizedStem,
    groupKey
  })
}

function groupId(normalizedDirectory: string, normalizedStem: string): string {
  return `cosa:${normalizedDirectory ? `${normalizedDirectory}/` : ''}${normalizedStem}`
}

function displayGroupName(group: Pick<MutableGroup, 'normalizedDirectory' | 'normalizedStem'>): string {
  return `${group.normalizedDirectory ? `${group.normalizedDirectory}/` : ''}${group.normalizedStem}`
}

function duplicateDiagnostic(group: MutableGroup, groupIdentifier: string, memberKind: CosaFileGroupMemberKind, files: readonly SurveyFileDescriptor[]): CosaFileGroupDiagnostic {
  const suffix = `.${memberKind}`
  return Object.freeze({
    code: 'cosa_duplicate_member',
    localized: { en: { message: `COSA group “${displayGroupName(group)}” contains ${files.length} ${suffix} members; no unambiguous member can be selected.`, suggestedAction: `Keep one same-stem ${suffix} file per group, or give different networks distinct base names and reimport.` } },
    severity: 'blocking',
    message: `COSA 文件组“${displayGroupName(group)}”包含 ${files.length} 个 ${suffix} 成员，无法安全选择其中之一。`,
    suggestedAction: `仅保留一个同名 ${suffix} 文件，或为不同控制网使用不同主文件名后重新导入。`,
    groupId: groupIdentifier,
    memberKind,
    files: Object.freeze([...files])
  })
}

function orphanAuxiliaryDiagnostic(
  group: MutableGroup,
  groupIdentifier: string,
  memberKind: 'net' | 'xyo',
  files: readonly SurveyFileDescriptor[]
): CosaFileGroupDiagnostic {
  const suffix = `.${memberKind}`
  return Object.freeze({
    code: 'cosa_orphan_auxiliary',
    localized: { en: { message: `COSA auxiliary ${suffix} has no same-stem .in2 observation file and cannot be linked to a control network.`, suggestedAction: 'Select the same-stem .in2 observation file, or correct the companion/network base names and reimport.' } },
    severity: 'blocking',
    message: `COSA 辅助文件 ${suffix} 没有找到同名 .in2 主观测文件，不能独立关联到控制网。`,
    suggestedAction: '同时选择同名 .in2 主观测文件，或将辅助文件与正确控制网统一命名后重新导入。',
    groupId: groupIdentifier,
    memberKind,
    requiredPrimaryMemberKind: 'in2' as const,
    files: Object.freeze([...files])
  })
}

function orphanResultDiagnostic(
  group: MutableGroup,
  groupIdentifier: string,
  memberKind: 'ou1' | 'ou2',
  files: readonly SurveyFileDescriptor[]
): CosaFileGroupDiagnostic {
  const primaryKind = COSA_FILE_GROUP_REQUIRED_PRIMARY_BY_MEMBER_KIND[memberKind]
  const suffix = `.${memberKind}`
  const primarySuffix = `.${primaryKind}`
  return Object.freeze({
    code: 'cosa_orphan_result',
    localized: { en: { message: `COSA result ${suffix} has no same-stem ${primarySuffix} observation file; result comparison cannot be linked safely.`, suggestedAction: `Select the same-stem ${primarySuffix} observation file; otherwise retain the original ${suffix} for archive review only.` } },
    severity: 'blocking',
    message: `COSA 成果文件 ${suffix} 没有找到同名 ${primarySuffix} 主观测文件，不能安全建立成果比对关联。`,
    suggestedAction: `同时选择同名 ${primarySuffix} 主观测文件；否则保留 ${suffix} 原件仅供归档审查。`,
    groupId: groupIdentifier,
    memberKind,
    requiredPrimaryMemberKind: primaryKind,
    files: Object.freeze([...files])
  })
}

/**
 * Group caller-provided COSA `.in1`, `.in2`, `.NET`, `.XYO`, `.ou1`, and
 * `.ou2` descriptors by the same case-normalized logical stem. `.NET` and
 * `.XYO` require `.in2` to form a usable plane-control association; `.ou1`
 * and `.ou2` require `.in1` and `.in2` respectively for result comparison.
 * The absence of optional companion/result files never blocks an input file.
 * Any duplicate member or orphan companion/result stays blocked for explicit
 * user correction, while all descriptors remain caller-owned originals.
 */
export function identifyCosaFileGroups(descriptors: readonly SurveyFileDescriptor[]): CosaFileGroupResult {
  const grouped = new Map<string, MutableGroup>()

  for (const descriptor of descriptors) {
    const candidate = candidateFor(descriptor)
    if (!candidate) continue
    let group = grouped.get(candidate.groupKey)
    if (!group) {
      group = {
        normalizedDirectory: candidate.normalizedDirectory,
        normalizedStem: candidate.normalizedStem,
        members: { in1: [], in2: [], net: [], xyo: [], ou1: [], ou2: [] }
      }
      grouped.set(candidate.groupKey, group)
    }
    group.members[candidate.memberKind].push(candidate.descriptor)
  }

  const diagnostics: CosaFileGroupDiagnostic[] = []
  const groups = [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, group]) => {
      const members: CosaFileGroupMembers = Object.freeze({
        in1: Object.freeze([...group.members.in1].sort(compareDescriptors)),
        in2: Object.freeze([...group.members.in2].sort(compareDescriptors)),
        net: Object.freeze([...group.members.net].sort(compareDescriptors)),
        xyo: Object.freeze([...group.members.xyo].sort(compareDescriptors)),
        ou1: Object.freeze([...group.members.ou1].sort(compareDescriptors)),
        ou2: Object.freeze([...group.members.ou2].sort(compareDescriptors))
      })
      const identifier = groupId(group.normalizedDirectory, group.normalizedStem)
      const groupDiagnostics: CosaFileGroupDiagnostic[] = []

      for (const memberKind of COSA_FILE_GROUP_MEMBER_KINDS) {
        const files = members[memberKind]
        if (files.length > 1) groupDiagnostics.push(duplicateDiagnostic(group, identifier, memberKind, files))
      }
      if (!members.in2.length) {
        if (members.net.length) groupDiagnostics.push(orphanAuxiliaryDiagnostic(group, identifier, 'net', members.net))
        if (members.xyo.length) groupDiagnostics.push(orphanAuxiliaryDiagnostic(group, identifier, 'xyo', members.xyo))
        if (members.ou2.length) groupDiagnostics.push(orphanResultDiagnostic(group, identifier, 'ou2', members.ou2))
      }
      if (!members.in1.length && members.ou1.length) {
        groupDiagnostics.push(orphanResultDiagnostic(group, identifier, 'ou1', members.ou1))
      }

      const frozenDiagnostics = Object.freeze([...groupDiagnostics])
      diagnostics.push(...frozenDiagnostics)
      return Object.freeze({
        id: identifier,
        family: 'cosa' as const,
        normalizedStem: group.normalizedStem,
        normalizedDirectory: group.normalizedDirectory,
        members,
        memberRoles: COSA_FILE_GROUP_MEMBER_ROLE_BY_KIND,
        state: frozenDiagnostics.length ? 'blocked' as const : 'ready' as const,
        diagnostics: frozenDiagnostics
      })
    })

  return Object.freeze({
    groups: Object.freeze(groups),
    diagnostics: Object.freeze(diagnostics)
  })
}
