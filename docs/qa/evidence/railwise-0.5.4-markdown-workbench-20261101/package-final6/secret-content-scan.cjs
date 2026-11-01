const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { TextDecoder } = require('node:util')
const { createRequire } = require('node:module')
const privateRoot = '/private/tmp/railwise-0.5.4-markdown-workbench-private-20261101-final6'
const persistentRoot = '/Users/wangjiawei/Documents/WorkWise/dist/railwise-0.5.4-markdown-workbench-private-final'
const app = path.join(persistentRoot, 'Applications/RailWise AI Candidate 1864d44d23f5.app')
const asar = createRequire(path.join(privateRoot, 'source/package.json'))('@electron/asar')
const archive = path.join(app, 'Contents/Resources/app.asar')
const output = '/Users/wangjiawei/Documents/WorkWise/docs/qa/evidence/railwise-0.5.4-markdown-workbench-20261101/package-final6/secret-content-scan.json'
const MAX_BYTES = 32 * 1024 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true })
const findings = []
const stats = { archive: { files: 0, textFiles: 0, textBytes: 0, binarySkipped: 0, sizeSkipped: 0, linkSkipped: 0 }, appResources: { files: 0, textFiles: 0, textBytes: 0, binarySkipped: 0, sizeSkipped: 0, linkSkipped: 0 }, candidateLogs: { files: 0, textFiles: 0, textBytes: 0, binarySkipped: 0, sizeSkipped: 0, linkSkipped: 0 } }
const skipped = []
const fixtureMarkers = ['fixture-document-', 'Markdown workbench acceptance fixture']
const fixtureRoot = path.join(persistentRoot, 'home/workspace/markdown-workbench')
for (const filename of ['large-protection.md', 'external-target.md', 'export-check.md', 'export-stress.md']) {
  const target = path.join(fixtureRoot, filename)
  if (!fs.existsSync(target)) continue
  const text = fs.readFileSync(target, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (line.length >= 12 && line.length <= 180 && /(?:MARKER|SENTINEL|PROTECTION|WORKBENCH|EXTERNAL.*(?:EDIT|DISK)|RAILWISE.*(?:END|FIXTURE))/i.test(line)) fixtureMarkers.push(line)
  }
}
const rules = [
  { id: 'private-key-block', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\r\n]+([A-Za-z0-9+/=\r\n]{64,})[\s\r\n]+-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { id: 'provider-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{50,255}|sk-(?:proj-|ant-[A-Za-z0-9]+-)?[A-Za-z0-9_-]{32,255}|xox[baprs]-[A-Za-z0-9-]{24,255}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16})\b/g },
  { id: 'jwt-literal', regex: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}\b/g },
  { id: 'credential-url', regex: /\b(?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s:/"'<>]{1,100}:([^\s@/"'<>]{8,200})@[^\s/"'<>]+/g },
  { id: 'populated-credential-literal', regex: /(?:["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|authorization|bearerToken)["']?)\s*[:=]\s*(["'`])([^"'`\r\n]{8,512})\1/gi, valueGroup: 2 }
]
function classify(value, rule) {
  if (/^(?:\*+|x+|0+|1+|a+|test(?:[-_ ]|$)|dummy(?:[-_ ]|$)|example(?:[-_ ]|$)|sample(?:[-_ ]|$)|your(?:[-_ ]|$)|replace(?:[-_ ]|$)|changeme|placeholder|redacted|undefined|null|false|true)/i.test(value)
    || /(?:your[_ -]?(?:api|key|token|secret|password)|example\.com|localhost|127\.0\.0\.1|\$\{|process\.env|<[^>]+>|__[^_]+__|\[redacted\]|\.env\b)/i.test(value)) return 'example-or-placeholder'
  if (rule === 'populated-credential-literal' && (/\s/.test(value) || /[{}()[\];]/.test(value) || /^(?:[a-z]+:|\.?\.?\/|(?:Bearer|Basic)\s)/.test(value))) return 'code-or-descriptive-literal'
  return 'review-required'
}
function scanBuffer(label, buffer, area) {
  const stat = stats[area]; stat.files++
  if (buffer.length > MAX_BYTES) { stat.sizeSkipped++; skipped.push({ file: label, reason: 'over-32-MiB-limit', bytes: buffer.length }); return }
  let text
  try { text = utf8.decode(buffer) } catch { stat.binarySkipped++; return }
  if (text.includes('\u0000')) { stat.binarySkipped++; return }
  stat.textFiles++; stat.textBytes += buffer.length
  const counts = new Map()
  for (const rule of rules) {
    rule.regex.lastIndex = 0
    for (const match of text.matchAll(rule.regex)) {
      const classification = classify(match[rule.valueGroup ?? 0], rule.id)
      const key = rule.id + '|' + classification
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  let markers = 0
  for (const marker of new Set(fixtureMarkers)) if (text.includes(marker)) markers++
  if (markers) counts.set('acceptance-fixture-body-marker|fixture-content-present', markers)
  for (const [key,count] of counts) {
    const [rule,classification] = key.split('|')
    findings.push({ file: label, rule, classification, count })
  }
}
for (const raw of asar.listPackage(archive)) {
  const relative = raw.replace(/^\//, '')
  const info = asar.statFile(archive, relative)
  if (info.files) continue
  if (info.link) { stats.archive.linkSkipped++; continue }
  scanBuffer('app.asar/' + relative, asar.extractFile(archive, relative), 'archive')
}
function walk(directory, area, base, label) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) { stats[area].linkSkipped++; continue }
    if (entry.isDirectory()) walk(target, area, base, label)
    else if (entry.isFile()) {
      if (target === archive) continue
      const relative = path.relative(base, target)
      const size = fs.statSync(target).size
      if (size > MAX_BYTES) { stats[area].files++; stats[area].sizeSkipped++; skipped.push({ file: label + '/' + relative, reason: 'over-32-MiB-limit', bytes: size }); continue }
      scanBuffer(label + '/' + relative, fs.readFileSync(target), area)
    }
  }
}
walk(path.join(app, 'Contents/Resources'), 'appResources', path.join(app, 'Contents/Resources'), 'app-resources')
const logRoots = []
for (const root of [privateRoot,persistentRoot]) for (const folder of ['logs','user-data/logs']) {
  const target = path.join(root,folder)
  if (fs.existsSync(target)) { logRoots.push(target); walk(target, 'candidateLogs', root, root === privateRoot ? 'temporary-candidate' : 'persistent-candidate') }
}
const report = {
  candidateHead: '1864d44d23f5328d5fc435edec9323b57db53ece',
  archiveSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
  generatedAt: new Date().toISOString(), scope: { archive, resourcesRoot: path.join(app, 'Contents/Resources'), candidateLogRoots: logRoots, decoder: 'Strict UTF-8; NUL-containing, undecodable, links and files over 32 MiB skipped', maxFileBytes: MAX_BYTES, fixtureMarkerCount: new Set(fixtureMarkers).size },
  rules: rules.map(({id})=>id).concat('acceptance-fixture-body-marker'),
  stats, findings, skipped,
  summary: { reviewRequiredFindings: findings.filter(x=>x.classification==='review-required').length, fixtureMarkerFindings: findings.filter(x=>x.rule==='acceptance-fixture-body-marker').length, suppressedExampleOrCodeFindings: findings.filter(x=>['example-or-placeholder','code-or-descriptive-literal'].includes(x.classification)).length },
  limitations: ['Pattern-based read-only scan, not exhaustive secret detection or credential validity checking.', 'No network, process memory, Keychain, production profile, workspace documents, binary decoding, archive nesting or complete base64 deobfuscation inspected.', 'Generic literals are candidates until reviewed; examples, minified code strings, test data and documentation can be false positives.', 'Candidate logs were read at scan time and may grow after the scan.', 'Matched values and content excerpts are intentionally never written or printed.']
}
fs.writeFileSync(output, JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({report:output,stats,summary:report.summary},null,2))
