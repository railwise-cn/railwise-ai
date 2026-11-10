import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

const root = process.cwd()
const scanRoots = ['src', 'scripts', '.github', 'docs', 'release', 'website']
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
  // The release identity migration documents the unchanged historical bundle ID.
  /^docs\/MIGRATION_RELEASE_IDENTITY\.zh-CN\.md$/,
  // QA evidence must preserve exact legacy identifiers (for example the
  // historical bundle id) so release-gate records remain auditable.
  /^docs\/qa\/evidence\//,
  // The durable-workbench acceptance record preserves the exact compatibility
  // bundle identity for the reviewed package; it is evidence, not product copy.
  /^docs\/qa\/durable-task-workbench-acceptance-2026-11-09\.md$/,
  /^website\/products\/screenshots\/workwise\/release-[0-9]+-screenshots\.json$/,
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
  // This private QA tool protects/restores exact legacy storage names and
  // detects old application processes. It is never bundled as product UI.
  /^docs\/qa\/release-gates\/v0\.5\.3\/normal-profile-protection\.mjs$/,
  /^src\/main\/claw-schedule-mcp-config\.test\.ts$/,
  /^src\/main\/services\/(?:agent-pack|skill)-service\.test\.ts$/,
  /^src\/preload\/index(?:\.d)?\.ts$/,
  /^scripts\/verify-brand-boundary\.mjs$/
]

// These files exercise or declare the precise historical workspace namespaces.
// Remove only those literals before checking each line: unrelated product copy
// in the same file must still fail the boundary check.
const workspaceCompatibilityFiles = new Set([
  'src/main/ipc/app-ipc-schemas.test.ts',
  'src/main/ipc/register-app-ipc-handlers.test.ts',
  'src/main/services/workspace-migration-service.ts',
  'src/main/services/workspace-migration-service.test.ts',
  'src/shared/workspace-migration.ts',
  'src/renderer/src/components/chat/SidebarProjectsSection.test.ts',
  'src/renderer/src/lib/workspace-path.test.ts',
  'src/renderer/src/store/chat-store-helpers.test.ts'
])

function withoutWorkspaceCompatibilityLiterals(rel, line) {
  let content = line
  if (workspaceCompatibilityFiles.has(rel)) {
    content = content.replace(/(['"])(?:\/[Uu]sers\/(?:example|zxy)\/)?\.workgpt(?:\/(?:default|write)_workspace|:(?:default|write))?\1/g, '$1$1')
    if (rel === 'src/renderer/src/components/chat/SidebarProjectsSection.test.ts') {
      content = content.replace(/(['"])\/users\/example\/\.kun\/default_workspace\1/g, '$1$1')
    }
  }
  if (
    /^src\/renderer\/src\/locales\/(?:en|zh)\/settings\.json$/.test(rel) &&
    /^\s*"workspaceMigration(?:Description|Namespace_workgpt)":/.test(line)
  ) content = content.replace(/"workspaceMigrationNamespace_workgpt":/, '"workspaceMigrationNamespace":').replace(/\.workgpt\b/g, '')
  if (rel === 'docs/harness-trusted-execution.md' && line.includes('迁移服务盘点')) {
    content = content.replace(/`\.workgpt`/g, '')
  }
  return content
}

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
      rule.pattern.lastIndex = 0
      if (!rule.pattern.test(withoutWorkspaceCompatibilityLiterals(rel, line))) continue
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

// Public-facing identities are distinct from compatibility keys. Check only
// prospective output strings here; legacy readers, old receipts, schemas and
// third-party provenance retain their exact original identities.
const publicIdentityFiles = [
  'src/main/settings-store.ts', 'src/main/services/write-docx-service.ts',
  'src/main/services/im-health-service.ts', 'src/main/claw-runtime.ts',
  'src/main/claw-schedule-mcp-server.ts', 'src/main/runtime/managed-runtime-adapter.ts',
  'src/main/services/write-inline-completion-service.ts',
  'src/renderer/src/agent/managed-runtime.ts', 'src/main/ipc/register-app-ipc-handlers.ts',
  'kun/src/prompt/kun-system-prompt.ts', 'kun/src/adapters/tool/ppt-master-tool-provider.ts',
  'src/shared/app-settings-prompts.ts', 'src/main/claw-schedule-mcp-config.ts'
]
const publicCopyFiles = [
  'src/main/services/git-checkpoint-service.ts', 'src/main/services/pypi-package-materializer.ts',
  'src/main/services/package-installation-service.ts', 'src/main/services/plugin-package-formats.ts',
  'src/main/services/managed-tool-service.ts', 'src/main/services/skill-service.ts',
  'src/main/claw-runtime-helpers.ts', 'src/main/weixin-bridge-runtime.ts',
  'src/renderer/src/plan/plan-prompts.ts', 'src/renderer/src/sdd/sdd-verify-prompt.ts',
  'src/renderer/src/sdd/sdd-assistant-prompt.ts', 'src/renderer/src/sdd/sdd-plan-prompt.ts',
  'src/renderer/src/write/quoted-selection.ts', 'kun/src/loop/tool-call-repair.ts',
  'kun/src/cli/agent-cli.ts', 'kun/src/adapters/tool/design-tool-provider.ts',
  'kun/src/network/safe-web-fetch.ts', 'src/main/index.ts',
  'kun/src/adapters/tool/builtin-read-tool.ts', 'kun/src/adapters/tool/flow-tool-provider.ts',
  'src/main/services/plugin-activation-service.ts'
]
const publicLegacyPatterns = [
  /(?:Welcome to|欢迎使用) WorkWise/,
  /(?:creator|displayName|pptx\.(?:author|company|subject))\s*[:=]\s*['"]WorkWise/,
  /You are WorkWise[, ]/,
  /(?:live WorkWise (?:IM|WeChat) bridge|The WorkWise main process|WorkWise answers that command)/,
  /(?:WorkWise Runtime (?:可访问|不可访问)|Failed to parse WorkWise Runtime MCP config)/,
  /(?:在 WorkWise 中|WorkWise 将自动重试)/,
  /WorkWise-task-diagnostics-/
]
for (const file of [...publicIdentityFiles, ...publicCopyFiles]) {
  const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith('//')) continue
    if (publicLegacyPatterns.some(pattern => pattern.test(line)) || (publicCopyFiles.includes(file) && /\bWorkWise\b/.test(line))) violations.push(`${file}:${index + 1}: public legacy product identity: ${line.trim()}`)
  }
}

if (violations.length > 0) {
  console.error(`RailWise AI brand boundary failed with ${violations.length} violation(s):`)
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`RailWise AI brand boundary passed (${files.length} files scanned).`)
