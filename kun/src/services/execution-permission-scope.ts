import { isAbsolute, relative, resolve, sep } from 'node:path'

export function intersectGrantValues(first?: readonly string[], second?: readonly string[]): string[] | undefined {
  if (!first) return second ? [...second] : undefined
  if (!second) return [...first]
  if (first.includes('*')) return [...second]
  if (second.includes('*')) return [...first]
  return first.filter(value => second.includes(value))
}

export function intersectGrantedPaths(requested: readonly string[], ceiling?: readonly string[]): string[] {
  if (!ceiling || ceiling.includes('*')) return [...requested]
  if (requested.includes('*')) return [...ceiling]
  const result = new Set<string>()
  for (const requestedRoot of requested) for (const allowedRoot of ceiling) {
    if (pathWithin(allowedRoot, requestedRoot)) result.add(resolve(requestedRoot))
    else if (pathWithin(requestedRoot, allowedRoot)) result.add(resolve(allowedRoot))
  }
  return [...result]
}

function pathWithin(root: string, target: string): boolean {
  const difference = relative(resolve(root), resolve(target))
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
}
