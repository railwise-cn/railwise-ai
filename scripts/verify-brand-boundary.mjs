import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

const root = process.cwd()
const scanRoots = ['src', 'scripts', '.github', 'docs', 'release']
const scanFiles = ['README.md', 'README.en.md', 'DESIGN.md', 'DESIGN.zh-CN.md', 'electron-builder.cjs', 'package.json']
const textExtensions = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.json', '.md', '.yml', '.yaml', '.sh', '.ps1', '.html', '.css'])
const forbidden = [
  { name: 'product name', pattern: /\bKun\b/g },
  { name: 'deprecated renderer API', pattern: /kunGui/g },
  { name: 'old log or package prefix', pattern: /kun-gui/gi },
  { name: 'old home path', pattern: /(?:~|[\\/])\.kun(?:[\\/]|$)/g },
  { name: 'old SDD path', pattern: /\.kunsdd/g },
  { name: 'old product name', pattern: /DeepSeek GUI/gi },
  { name: 'old product prefix', pattern: /deepseek-gui/gi },
  { name: 'old product name', pattern: /WorkGPT/gi },
  { name: 'old environment variable', pattern: /\b(?:KUN_(?:STARTUP_TRACE|RUNTIME_TOKEN)|DEEPSEEK_GUI_[A-Z0-9_]+|WORKGPT_[A-Z0-9_]+)\b/g }
]
const forbiddenPaths = [
  { name: 'deprecated renderer API path', pattern: /kunGui/ },
  { name: 'old log or package path', pattern: /kun-gui/i },
  { name: 'old home path', pattern: /(?:^|\/)\.kun(?:\/|$)/ },
  { name: 'old SDD path', pattern: /\.kunsdd(?:\/|$)/ },
  { name: 'old product path', pattern: /deepseek-gui/i },
  { name: 'old product path', pattern: /workgpt/i }
]

const allowedFiles = [
  /^FORK_NOTICE\.md$/,
  /^LICENSE(?:\.|$)/,
  /^docs\/PUBLIC_BEHAVIOR_GAP_0\.2\.5\.zh-CN\.md$/,
  // QA evidence must preserve exact legacy identifiers (for example the
  // historical bundle id) so release-gate records remain auditable.
  /^docs\/qa\/evidence\//,
  /^src\/main\/compat\//,
  /^src\/main\/legacy-data-migration(?:\.test)?\.ts$/,
  /^src\/main\/settings-store(?:\.test)?\.ts$/,
  /^src\/renderer\/src\/lib\/legacy-local-storage-migration(?:\.test)?\.ts$/,
  /^src\/renderer\/src\/lib\/legacy-workspace-paths\.ts$/,
  /^src\/renderer\/src\/plan\/plan-prompts\.ts$/,
  /^src\/renderer\/src\/plan\/plan-request\.test\.ts$/,
  /^src\/shared\/gui-plan(?:\.test)?\.ts$/,
  /^src\/shared\/app-settings-(?:runtime|types)(?:\.test)?\.ts$/,
  /^src\/shared\/legacy-agent-name\.ts$/,
  /^scripts\/authorize-workwise-candidate\.sh$/,
  // Release verification must preserve historical bundle IDs and storage paths
  // so it can validate and migrate existing installations without exposing them
  // in product UI or user-facing copy.
  /^scripts\/(?:run-frozen-release-updater-acceptance|verify-reviewed-release-artifacts)\.mjs$/,
  /^src\/main\/claw-schedule-mcp-config\.test\.ts$/,
  /^src\/main\/services\/(?:agent-pack|skill)-service\.test\.ts$/,
  /^src\/preload\/index(?:\.d)?\.ts$/,
  /^scripts\/verify-brand-boundary\.mjs$/
]

function portable(path) {
  return path.split(sep).join('/')
}

const scannedPaths = []

function collect(dir, output) {
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name)
    const rel = portable(relative(root, absolute))
    if (rel === 'kun' || rel.startsWith('kun/') || rel.includes('/node_modules/') || rel.includes('/dist/') || rel.includes('/out/')) continue
    scannedPaths.push(rel)
    const stat = statSync(absolute)
    if (stat.isDirectory()) collect(absolute, output)
    else if (textExtensions.has(extname(name))) output.push(absolute)
  }
}

const files = scanFiles.map((file) => join(root, file))
scannedPaths.push(...scanFiles)
for (const scanRoot of scanRoots) collect(join(root, scanRoot), files)

const violations = []
for (const rel of scannedPaths) {
  if (allowedFiles.some((pattern) => pattern.test(rel))) continue
  for (const rule of forbiddenPaths) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(rel)) violations.push(`${rel}: ${rule.name}`)
  }
}
for (const absolute of files) {
  const rel = portable(relative(root, absolute))
  if (allowedFiles.some((pattern) => pattern.test(rel))) continue
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const rule of forbidden) {
      rule.pattern.lastIndex = 0
      if (!rule.pattern.test(line)) continue
      if (
        (rel === 'electron-builder.cjs' || rel === 'src/main/index.ts') &&
        line.includes("com.wangjiawei508.workgpt")
      ) continue
      // Acceptance records must retain the exact identity of historical packages.
      if (rel.startsWith('docs/qa/release-gates/') && rule.name === 'old product name') {
        const withoutPackageIdentity = line.replace(/\bcom\.wangjiawei508\.workgpt(?:\.candidate\.head[a-f0-9]{12})?\b/g, '')
        rule.pattern.lastIndex = 0
        if (!rule.pattern.test(withoutPackageIdentity)) continue
      }
      violations.push(`${rel}:${index + 1}: ${rule.name}: ${line.trim()}`)
    }
  }
}

if (violations.length > 0) {
  console.error(`WorkWise brand boundary failed with ${violations.length} violation(s):`)
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`WorkWise brand boundary passed (${files.length} files scanned).`)
