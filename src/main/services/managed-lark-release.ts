import dependencies from '../../shared/managed-dependencies.json'

/** Official binaries and companion sources share the immutable dependency manifest. */
const source = dependencies.files.find(item => item.id === 'lark-source')!
export const LARK_RELEASE = {
  version: source.version,
  sourceCommit: dependencies.upstreamRevisions.lark,
  sourceUrl: source.sourceUrl,
  sourceSha256: source.sha256,
  assets: Object.fromEntries(dependencies.files
    .filter(item => item.component === 'lark-cli' && item.role === 'runtime')
    .map(item => [item.name, item.sha256])) as Record<string, string>
} as const
