import type { MarketplacePackageV1 } from './marketplace'
import type { RuntimeRequestResult } from './workwise-api'

export type MarketplaceSkillReadiness = 'loaded' | 'pending' | 'disabled' | 'unavailable'

type SkillIdentity = { id: string; name: string; root: string }
type SkillSnapshot = { enabled: boolean; skills: SkillIdentity[] }

export function declaredMarketplaceSkills(components: MarketplacePackageV1['components']): string[] | undefined {
  const skills = components.filter(component => component.type === 'skill')
  return skills.length ? skills.flatMap(component => component.skillNames ?? []) : undefined
}

export function readMarketplaceSkillSnapshot(
  response: RuntimeRequestResult | void,
  field: 'state' | 'skills'
): SkillSnapshot | undefined {
  if (!response?.ok) return undefined
  try {
    const snapshot = JSON.parse(response.body)?.[field]
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

export function marketplaceSkillReadiness(
  snapshot: SkillSnapshot | undefined,
  artifactRoot: string,
  names: string[]
): MarketplaceSkillReadiness {
  if (!snapshot) return 'unavailable'
  if (!snapshot.enabled) return 'disabled'
  const base = pathKey(artifactRoot)
  const loaded = snapshot.skills.filter(skill => {
    const root = pathKey(skill.root)
    return (root === base || root.startsWith(`${base}/`)) && !root.split('/').includes('..')
  })
  const identities = new Set(loaded.flatMap(skill => [nameKey(skill.name), nameKey(skill.id)]))
  return loaded.length && names.every(name => identities.has(nameKey(name))) ? 'loaded' : 'pending'
}
