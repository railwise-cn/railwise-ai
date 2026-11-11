import dependencies from '../../shared/managed-dependencies.json'

/** Official OfficeCLI binaries and companion Skills are pinned together. */
const source = dependencies.files.find(item => item.id === 'office-source')!
export const OFFICE_RELEASE = {
  version: source.version,
  sourceCommit: dependencies.upstreamRevisions.officecli,
  sourceUrl: source.sourceUrl,
  sourceSha256: source.sha256,
  assets: Object.fromEntries(dependencies.files
    .filter(item => item.component === 'officecli' && item.role === 'runtime')
    .map(item => [item.name, item.sha256])) as Record<string, string>
} as const
