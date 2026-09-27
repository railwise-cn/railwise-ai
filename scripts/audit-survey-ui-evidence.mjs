import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Static source inventory only: no application, user database or network access.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const componentDir = 'src/renderer/src/components/engineering'
const localeDir = 'src/renderer/src/locales'
const namespaceFiles = {
  common: 'common.json', qualityScoring: 'quality-scoring.json',
  qualityAssessment: 'quality-assessment.json', standardBasis: 'standard-basis.json'
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const flatten = (value, prefix = '', result = {}) => {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') result[path] = child
    else if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, path, result)
  }
  return result
}
const catalogs = {}
const sourceFiles = []
function read(path) {
  const bytes = readFileSync(join(root, path))
  sourceFiles.push({ path, sha256: hash(bytes) })
  return bytes.toString('utf8')
}
for (const [namespace, filename] of Object.entries(namespaceFiles)) {
  catalogs[namespace] = Object.fromEntries(['zh', 'en'].map(language =>
    [language, flatten(JSON.parse(read(`${localeDir}/${language}/${filename}`)))]))
}
const paths = readdirSync(join(root, componentDir))
  .filter(name => /\.tsx?$/.test(name) && !/\.(test|spec)\./.test(name))
  .sort().map(name => `${componentDir}/${name}`)
const literalCalls = []
const dynamicCalls = []
const catalogStringCandidates = []
const untranslatedJsxCandidates = []
for (const path of paths) {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const namespaces = new Set()
  function findNamespaces(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useTranslation') {
      const arg = node.arguments[0]
      if (!arg) namespaces.add('common')
      else if (ts.isStringLiteralLike(arg)) namespaces.add(arg.text)
      else namespaces.add('UNRESOLVED')
    }
    ts.forEachChild(node, findNamespaces)
  }
  findNamespaces(source)
  const namespace = namespaces.size === 1 ? [...namespaces][0] : namespaces.size === 0 ? 'common' : 'UNRESOLVED'
  const location = node => ({ path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteralLike(arg)) literalCalls.push({ ...location(node), namespace, key: arg.text })
      else dynamicCalls.push({ ...location(node), namespace, expression: arg?.getText(source) ?? '<missing>' })
    }
    if (ts.isStringLiteralLike(node) && catalogs[namespace]
      && (Object.hasOwn(catalogs[namespace].zh, node.text) || Object.hasOwn(catalogs[namespace].en, node.text))
      && !(ts.isCallExpression(node.parent) && ts.isIdentifier(node.parent.expression)
        && node.parent.expression.text === 't' && node.parent.arguments[0] === node)) {
      catalogStringCandidates.push({ ...location(node), namespace, key: node.text })
    }
    if (ts.isJsxText(node) && node.text.trim()) {
      untranslatedJsxCandidates.push({ ...location(node), kind: 'jsx-text', text: node.text.trim() })
    }
    if (ts.isJsxAttribute(node) && ['aria-label', 'title', 'placeholder', 'alt'].includes(node.name.getText(source)) && node.initializer) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
      if (value && ts.isStringLiteralLike(value)) untranslatedJsxCandidates.push({ ...location(node), kind: node.name.getText(source), text: value.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
const selected = [...new Set([...literalCalls, ...catalogStringCandidates].map(item => `${item.namespace}:${item.key}`))].sort()
const selectedKeys = selected.map(id => {
  const split = id.indexOf(':')
  const namespace = id.slice(0, split), key = id.slice(split + 1)
  const zh = catalogs[namespace]?.zh[key], en = catalogs[namespace]?.en[key]
  return { namespace, key, zh: zh ?? null, en: en ?? null, englishContainsHan: typeof en === 'string' && /\p{Script=Han}/u.test(en) }
})
const catalogParity = Object.fromEntries(Object.entries(catalogs).map(([namespace, languages]) => [namespace, {
  zhLeaves: Object.keys(languages.zh).length, enLeaves: Object.keys(languages.en).length,
  missingEn: Object.keys(languages.zh).filter(key => !Object.hasOwn(languages.en, key)),
  missingZh: Object.keys(languages.en).filter(key => !Object.hasOwn(languages.zh, key))
}]))
// These are presentation dependencies, not additional audited JSX surfaces.
for (const path of ['src/renderer/src/i18n.ts', 'src/shared/product-brand.json',
  ...['survey-service.json', 'engineering-diagnostics.json', 'survey-parser-diagnostics.json'].map(name => `${localeDir}/en/${name}`)]) read(path)
const summary = {
  componentFiles: paths.filter(path => path.endsWith('.tsx')).length,
  helperFiles: paths.filter(path => path.endsWith('.ts')).length,
  literalCallSites: literalCalls.length, dynamicCallSites: dynamicCalls.length,
  catalogStringCandidateSites: catalogStringCandidates.length,
  selectedUniqueKeys: selectedKeys.length,
  selectedMissingEn: selectedKeys.filter(item => item.en === null).length,
  selectedMissingZh: selectedKeys.filter(item => item.zh === null).length,
  selectedEnglishHanKeys: selectedKeys.filter(item => item.englishContainsHan).map(item => `${item.namespace}:${item.key}`),
  untranslatedJsxCandidateSites: untranslatedJsxCandidates.length
}
const report = {
  schema: 'survey-ui-static-inventory-v1',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSetSha256: hash(JSON.stringify(sourceFiles)),
  boundary: 'Static engineering-directory inventory. Dynamic calls, external shared components, runtime text and actual visible states require separate review. No GUI or production coverage rate.',
  summary, catalogParity, sourceFiles, literalCalls, dynamicCalls, catalogStringCandidates,
  selectedKeys, untranslatedJsxCandidates,
  script: relative(root, fileURLToPath(import.meta.url))
}
process.stdout.write(`${JSON.stringify(process.argv.includes('--summary') ? { head: report.head, sourceSetSha256: report.sourceSetSha256, summary, catalogParity } : report, null, 2)}\n`)
