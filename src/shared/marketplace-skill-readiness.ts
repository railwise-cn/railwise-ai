import type { MarketplacePackageV1 } from './marketplace'
import type { RuntimeRequestResult } from './workwise-api'

export type MarketplaceSkillReadiness = 'loaded' | 'pending' | 'disabled' | 'unavailable' | 'different-workspace'

type SkillIdentity = { id: string; name: string; root: string }
type SkillSnapshot = { enabled: boolean; skills: SkillIdentity[] }

export function declaredMarketplaceSkills(
  components: MarketplacePackageV1['components'],
  item?: Pick<MarketplacePackageV1, 'id' | 'source' | 'version'>
): string[] | undefined {
  const skills = components.filter(component => component.type === 'skill')
  if (!skills.length) return undefined
  // Read the original official receipts without replacing them or changing their review hashes.
  if (item?.source?.catalogSourceId === 'workwise-official') {
    if (item.id === 'superpowers' && item.version === '44c9b2d6e889982ac18c27d05a19fefe335194e1') return ['using-superpowers']
    if (item.id === 'blender-skills' && item.version === '8f778d2405a214b508d4c7d80742be8e43acdd52') return ['blender-director']
  }
  return skills.flatMap(component => component.skillNames ?? [])
}

export function readMarketplaceSkillSnapshot(
  response: RuntimeRequestResult | void,
  field?: 'state' | 'skills'
): SkillSnapshot | undefined {
  if (!response?.ok) return undefined
  try {
    const body = JSON.parse(response.body)
    const snapshot = field ? body?.[field] : body
    if (typeof snapshot?.enabled !== 'boolean' || !Array.isArray(snapshot.skills)) return undefined
    const skills = snapshot.skills.filter((skill: Partial<SkillIdentity> | null): skill is SkillIdentity =>
      typeof skill?.id === 'string' && typeof skill.name === 'string' && typeof skill.root === 'string')
    return { enabled: snapshot.enabled, skills }
  } catch {
    return undefined
  }
}

function pathKey(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

function nameKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

export function isMarketplaceSkillWorkspace(installedWorkspace: string | undefined, workspace: string): boolean {
  return !installedWorkspace || pathKey(installedWorkspace) === pathKey(workspace)
}

export function marketplaceLoadedSkills(snapshot: SkillSnapshot | undefined, artifactRoot: string): SkillIdentity[] {
  if (!snapshot?.enabled) return []
  const base = pathKey(artifactRoot)
  return snapshot.skills.filter(skill => {
    const root = pathKey(skill.root)
    return (root === base || root.startsWith(`${base}/`)) && !root.split('/').includes('..')
  })
}

export function marketplaceSkillReadiness(
  snapshot: SkillSnapshot | undefined,
  artifactRoot: string,
  names: string[]
): MarketplaceSkillReadiness {
  if (!snapshot) return 'unavailable'
  if (!snapshot.enabled) return 'disabled'
  const loaded = marketplaceLoadedSkills(snapshot, artifactRoot)
  const identities = new Set(loaded.flatMap(skill => [nameKey(skill.name), nameKey(skill.id)]))
  return loaded.length && names.every(name => identities.has(nameKey(name))) ? 'loaded' : 'pending'
}
