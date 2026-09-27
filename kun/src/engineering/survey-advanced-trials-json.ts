/** Exact UTF-8 JSON with bounded nesting and no duplicate/escaped-equivalent keys.
 * JSON.parse supplies syntax validation; the token pass prevents last-key-wins
 * ambiguity before any declaration is normalized by its schema. */
export function parseAdvancedTrialJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  const stack: Array<{ object: boolean; key: boolean; keys: Set<string> }> = []
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)) {
    const token = match[0], top = stack.at(-1)
    if (token === '{' || token === '[') {
      if (stack.length >= 32) throw new Error('JSON nesting limit')
      stack.push({ object: token === '{', key: token === '{', keys: new Set() })
    } else if (token === '}' || token === ']') stack.pop()
    else if (token === ',' && top?.object) top.key = true
    else if (token === ':' && top?.object) top.key = false
    else if (token.startsWith('"')) {
      const value = JSON.parse(token) as string
      if (new TextDecoder().decode(new TextEncoder().encode(value)) !== value) throw new Error('Invalid Unicode string')
      if (top?.object && top.key) {
        if (top.keys.has(value) || top.keys.size >= 10000) throw new Error('Ambiguous JSON keys')
        top.keys.add(value)
      }
    }
  }
  return parsed
}
