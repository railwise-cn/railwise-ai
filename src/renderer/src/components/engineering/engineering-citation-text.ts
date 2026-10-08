/**
 * Presentation guard for report citations.
 *
 * Citations are persisted as user supplied evidence, so they may contain an
 * implementation path, a content hash, or an internal record identifier. The
 * report and delivery surfaces should identify the professional source and
 * its location without exposing those implementation details. The original
 * citation remains unchanged in the archive.
 */

export type EngineeringCitationType = 'attachment' | 'knowledge-base' | 'standard' | 'other'

const internalCitation = /(?:\.workwise(?:[\\/]|$)|(?:^|[\\/])(?:src|out|kun|app\.asar|node_modules)[\\/]|\b(?:contextHash|sourceSha256|parserSourceHash|inputHash|outputHash|projectRevision|networkRevision|algorithmVersion|planId|taskId|threadId|toolId|selector|typedEvidence|schemaVersion|sha-?256|hash|revision|parser|runtime|fixture|manifest)\b|\b(?:context|source|input|output|parser|plan|task|thread|project|network)_(?:hash|id|revision)\b|(?:format|admission)\s+catalog|格式目录|受理目录|解析对象|工具(?:名|名称|ID)|\b(?:run|task|adjustment|manifest|analysis|result|network|project|source|parser|plan|context)[_-][0-9a-f]{8,}|\b[a-f0-9]{32,}\b)/i
const internalFile = /(?:^|[\\/])(?:manifest(?:\.json)?|evidence(?:\.json|\.xlsx)?|receipt(?:\.json)?)(?:$|[\\/_.])/i
const professionalFile = /\.(?:in1|in2|net|ou1|ou2|xyo|clo|gco|dat|gsi|asc|suc|csv|xlsx?|txt|pdf|docx?)$/i
const localPath = /(?:^|\s)(?:\/(?:Users|private|var|tmp|home|opt|Applications)\/|[A-Za-z]:[\\/]|(?:\.\.?|~)[\\/])/i

function clean(value: string): string {
  return value.replace(/\p{Cc}/gu, character => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 ? ' ' : character
  }).replace(/\s+/g, ' ').trim()
}

/** Returns a safe, human-readable citation source or a professional fallback. */
export function professionalCitationSource(value: string | undefined, type: EngineeringCitationType, english = false): string {
  const text = clean(value ?? '')
  if (!text) return english ? (type === 'attachment' ? 'Survey attachment' : 'Referenced source') : (type === 'attachment' ? '测量资料' : '引用来源')
  if (internalCitation.test(text) || internalFile.test(text)) {
    return english ? (type === 'attachment' ? 'Survey attachment' : 'Referenced source') : (type === 'attachment' ? '测量资料' : '引用来源')
  }
  // Keep the filename and standard title users need for review. Hide query
  // strings and fragments that commonly carry internal identifiers.
  const withoutQuery = text.split(/[?#]/, 1)[0]!.trim()
  if (localPath.test(withoutQuery)) {
    const filename = withoutQuery.split(/[\\/]/).pop() ?? ''
    return professionalFile.test(filename) && !internalCitation.test(filename) && !internalFile.test(filename)
      ? filename
      : english ? 'Referenced source' : '引用来源'
  }
  if (!withoutQuery) {
    return english ? 'Referenced source' : '引用来源'
  }
  return withoutQuery
}

/** Returns a safe location label, preserving survey rows, clauses and pages. */
export function professionalCitationLocator(value: string | undefined): string | undefined {
  const text = clean(value ?? '')
  if (!text || internalCitation.test(text) || internalFile.test(text) || localPath.test(text)) return undefined
  if (/\b(?:json|xml|yaml|csv)\b|[{}[\]]|(?:^|\s)(?:path|id|key|value|selector)\s*[:=]/i.test(text)) return undefined
  const withoutQuery = text.split(/[?#]/, 1)[0]!.trim()
  if (!withoutQuery || /(?:^|\s)(?:GET|POST|PUT|PATCH|DELETE)\s+\//i.test(withoutQuery)) return undefined
  // Locations are deliberately plain text: “第 5 行”, “第 3 条”, “page 2”.
  return withoutQuery
}

export function professionalCitationDisplay(source: string | undefined, sourceType: EngineeringCitationType, locator: string | undefined, english = false): string {
  const name = professionalCitationSource(source, sourceType, english)
  const location = professionalCitationLocator(locator)
  return location ? `${name} · ${location}` : name
}
