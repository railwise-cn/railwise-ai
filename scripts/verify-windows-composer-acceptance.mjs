import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const literal = JSON.stringify
const psQuote = value => "'" + value.replaceAll("'", "''") + "'"
const composer = 'textarea[placeholder="向智能体提问…"]:not(:disabled)'
const addMenu = 'button[aria-label="更多操作"]'
const sendButton = 'button[aria-label="发送"]:not(:disabled)'
const removeAttachment = 'button[aria-label="移除附件"]'
const fontMap = '铁路合成验收'
const textName = '中文文字样本.pdf'
const scanName = '扫描宣传册.pdf'
const invalidName = '损坏样本.pdf'
const skillReadFailure = '受控验收停止：技能读取证据不匹配。'
const pipelinePath = 'references/pipeline.md'
// SHA-256 verified from the locked Windows Video Shotcraft mirror payload.
const pipelineBytes = 24_312
const pipelineSha256 = '7593dd38ca5255febfc2778b0ed78b158edee8519e9070328480dd4be15c871e'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const toolCode = value => typeof value === 'string' && /^[a-z_]{1,80}$/.test(value) ? value : undefined
const safeDiagnostic = value => typeof value === 'string'
  ? value.slice(0, 240).replace(/(?:[a-zA-Z]:[\\/]|\/)(?:[^\s,;]+[\\/])+[^\s,;]+/g, '[local path]')
  : undefined

function describeResult(resource) {
  return {
    parsed: Boolean(resource),
    keys: Object.keys(resource ?? {}).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)).slice(0, 16),
    code: toolCode(resource?.code ?? resource?.error?.code),
    status: toolCode(resource?.status),
    error: safeDiagnostic(resource?.error?.message ?? resource?.error ?? resource?.message),
    isError: typeof resource?.isError === 'boolean' ? resource.isError : undefined,
    spilled: Boolean(resource?.contextSpill),
    excerptBytes: typeof resource?.excerpt === 'string' ? Buffer.byteLength(resource.excerpt) : undefined
  }
}

function requestTool(id, name, args) {
  return { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: literal(args) } }] }
}

export function createChineseTextPdf() {
  const glyphs = Array.from(fontMap)
  const map = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /RailWiseSmoke def /CMapType 2 def',
    '1 begincodespacerange <0000> <ffff> endcodespacerange',
    `${glyphs.length} beginbfchar`,
    ...glyphs.map((glyph, index) => `<${(index + 1).toString(16).padStart(4, '0')}> <${glyph.charCodeAt(0).toString(16)}>`),
    'endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
  ].join('\n')
  const content = `BT /F1 18 Tf 25 140 Td <${glyphs.map((_, i) => (i + 1).toString(16).padStart(4, '0')).join('')}> Tj ET`
  const stream = value => `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`
  const entries = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 280 170] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    stream(content),
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
    stream(map)
  ]
  const offsets = ['0000000000 65535 f ']
  let pdf = '%PDF-1.4\n'
  for (const [index, entry] of entries.entries()) {
    offsets.push(`${String(pdf.length).padStart(10, '0')} 00000 n `)
    pdf += `${index + 1} 0 obj\n${entry}\nendobj\n`
  }
  return Buffer.from(pdf + `xref\n0 ${offsets.length}\n${offsets.join('\n')}\ntrailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${pdf.length}\n%%EOF\n`)
}

function expandScanPdf(bytes) {
  const separator = Buffer.from('\nxref\n')
  const position = bytes.lastIndexOf(separator) + 1
  assert.ok(position > 1)
  const padding = Buffer.alloc(40 * 1024 * 1024 - bytes.length, 0x20)
  for (let i = 0; i < padding.length - 1; i += 1024) {
    padding[i] = 0x25
    if (i > 0) padding[i - 1] = 0x0a
  }
  padding[padding.length - 1] = 0x0a
  const trailer = bytes.subarray(position).toString('ascii')
    .replace(/startxref\s+\d+/, `startxref\n${position + padding.length}`)
  return Buffer.concat([bytes.subarray(0, position), padding, Buffer.from(trailer)])
}

export function createComposerModelAcceptance(parseToolOutput = value => JSON.parse(value)) {
  const observations = { skillRead: false, pluginRead: false, scanSent: false, chineseTextSent: false }
  const skillReadEvidence = {}
  const persistedSkillEvidence = {}
  const recallRequests = new Map()
  const skillTurnMarker = `railwise-skill-check-${randomUUID()}`
  const pluginTurnMarker = `railwise-plugin-check-${randomUUID()}`
  let skillId
  return {
    observations, skillReadEvidence, persistedSkillEvidence, skillTurnMarker, pluginTurnMarker,
    setSkillId(value) { skillId = value },
    modelAction(body) {
      const messages = body.messages ?? []
      const currentUser = [...messages].reverse().find(item => item.role === 'user')
      const text = literal(currentUser?.content ?? '')
      const history = literal(messages)
      const selected = text.includes(skillTurnMarker) ? 'skillRead' : text.includes(pluginTurnMarker) ? 'pluginRead' : null
      if (selected) {
        assert.ok(skillId)
        if (selected === 'pluginRead' && !messages.some(item =>
          typeof item.content === 'string' && item.content.includes('"kind":"plugin","id":"video-shotcraft"'))) {
          skillReadEvidence[selected] = { issue: 'missing_selected_plugin_reference' }
          return { content: skillReadFailure }
        }
        const id = `composer-${selected}`
        const readback = messages.find(item => item.role === 'tool' && item.tool_call_id === id)
        if (!readback) {
          if (!body.tools?.some(item => item.function?.name === 'read_skill_resource')) {
            skillReadEvidence[selected] = { issue: 'missing_advertised_skill_resource_tool' }
            return { content: skillReadFailure }
          }
          return requestTool(id, 'read_skill_resource', { skill_id: skillId, path: pipelinePath })
        }
        let resource = parseToolOutput(readback.content)
        const evidence = describeResult(resource)
        skillReadEvidence[selected] = evidence
        const reference = resource?.contextSpill
        if (reference) {
          if (typeof reference.bundle_id !== 'string' || typeof reference.object_id !== 'string'
            || !/^[a-f0-9]{64}$/.test(reference.sha256) || reference.mediaType !== 'application/json'
            || !Number.isSafeInteger(reference.totalBytes) || reference.totalBytes < 1 || reference.totalBytes > 64 * 1024
            || !body.tools?.some(item => item.function?.name === 'read_task_context')) {
            return { content: skillReadFailure }
          }
          const slices = []
          let offset = 0
          while (offset < reference.totalBytes && slices.length < 16) {
            const recallId = `${id}-recall-${offset}`
            const recall = messages.find(item => item.role === 'tool' && item.tool_call_id === recallId)
            if (!recall) {
              const args = { bundle_id: reference.bundle_id, object_id: reference.object_id, offset, max_bytes: 4096 }
              recallRequests.set(recallId, args)
              return requestTool(recallId, 'read_task_context', args)
            }
            const requested = recallRequests.get(recallId)
            const slice = parseToolOutput(recall.content)
            const next = typeof slice?.text === 'string' ? offset + Buffer.byteLength(slice.text) : offset
            if (slice?.sha256 !== reference.sha256 || slice.bundleId !== requested?.bundle_id || slice.objectId !== requested?.object_id
              || slice.offset !== offset || slice.totalBytes !== reference.totalBytes || next <= offset || next > reference.totalBytes
              || slice.nextOffset !== (next < reference.totalBytes ? next : null)) {
              evidence.recall = describeResult(slice)
              return { content: skillReadFailure }
            }
            slices.push(slice.text)
            offset = next
          }
          const original = slices.join('')
          if (offset !== reference.totalBytes || sha256(original) !== reference.sha256) return { content: skillReadFailure }
          evidence.recall = { verified: true, bytes: offset, slices: slices.length, sha256: reference.sha256 }
          resource = parseToolOutput(original)
        }
        const contents = typeof resource?.content === 'string' ? resource.content : ''
        const bytes = Buffer.byteLength(contents)
        Object.assign(evidence, {
          status: toolCode(resource?.status) ?? (bytes > 0 ? 'read' : evidence.status),
          skillMatches: resource?.skill_id === skillId,
          pathMatches: resource?.path === pipelinePath,
          bytes,
          declaredBytes: resource?.bytes_returned,
          offset: resource?.offset_bytes,
          sourceComplete: resource?.next_offset_bytes === null && resource?.bytes_returned === pipelineBytes
            && resource?.byte_size === pipelineBytes,
          modelView: bytes === pipelineBytes ? 'full' : contents.includes('[cache hygiene: omitted ') ? 'compacted' : 'unknown',
          ...(bytes > 0 && bytes <= 64 * 1024 ? { sha256: sha256(contents) } : {}),
          commandSnippet: /remotion\s+render/i.test(contents)
        })
        const validModelContent = evidence.modelView === 'full' ? evidence.sha256 === pipelineSha256
          : evidence.modelView === 'compacted' && bytes > 0 && bytes < pipelineBytes
        if (!evidence.skillMatches || !evidence.pathMatches || !evidence.sourceComplete || evidence.offset !== 0
          || !evidence.commandSnippet || !validModelContent) {
          return { content: skillReadFailure }
        }
        observations[selected] = true
        return { content: selected === 'pluginRead' ? '插件读取验收通过' : '技能读取验收通过' }
      }
      if (text.includes('请根据附件中实际可读取的内容继续处理') || text.includes('Please use the content you can read')) {
        if (!observations.scanSent && history.includes(scanName)) {
          // The real model request describes evidence quality, not invented brochure content.
          assert.match(history, /no_extractable_pdf_text|no extractable|no readable|no extracted|no text|image-only/i)
          observations.scanSent = true
          return { content: '扫描 PDF 原件已送达' }
        }
        if (history.includes(textName)) {
          assert.ok(history.replaceAll('\\u0000', '').replace(/\s+/g, '').includes(fontMap), 'The installed runtime must pass real Chinese PDF text to the model')
          observations.chineseTextSent = true
          return { content: '中文 PDF 文字已送达' }
        }
      }
      return null
    }
  }
}

async function key(cdp, name, code, windowsVirtualKeyCode, modifiers = 0) {
  const input = { key: name, code, windowsVirtualKeyCode, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...input })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...input })
}

async function continueAfterResponse(cdp, message) {
  const outcome = await cdp.wait(`(() => {
    const text = document.body.innerText
    if (text.includes(${literal(skillReadFailure)})) return 'failed'
    if (text.includes(${literal(message)}) && document.querySelector(${literal(composer)})) return 'passed'
  })()`, message, 120_000)
  assert.equal(outcome, 'passed', 'Real Skill readback failed; see bounded modelFixture.skillReadEvidence')
}

async function verifyPersistedSkillRead(cdp, threadId, selected, marker, skillId, acceptance) {
  const id = `composer-${selected}`
  const expression = `(async () => {
    const response = await window.workwise.runtimeRequest(${literal(`/v1/threads/${encodeURIComponent(threadId)}`)}, 'GET')
    if (!response.ok) return
    const thread = JSON.parse(response.body)
    const turn = thread.turns.find(item => item.items.some(entry =>
      entry.kind === 'user_message' && entry.text?.includes(${literal(marker)})))
    const call = turn?.items.find(item => item.kind === 'tool_call' && item.callId === ${literal(id)})
    const result = turn?.items.find(item => item.kind === 'tool_result' && item.callId === ${literal(id)})
    if (!call || !result) return
    const output = result.output
    const bytes = new TextEncoder().encode(typeof output?.content === 'string' ? output.content : '')
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return {
      // KUN keeps raw tool arguments ephemeral. The exact call ID was matched
      // above, and the linked result carries the executed Skill ID and path.
      callMatches: call.toolName === 'read_skill_resource',
      argumentsRedacted: Object.keys(call.arguments ?? {}).length === 0,
      resultMatches: result.toolName === 'read_skill_resource' && result.isError !== true && output?.skill_id === ${literal(skillId)}
        && output?.path === ${literal(pipelinePath)},
      declaredBytes: output?.bytes_returned,
      declaredTotalBytes: output?.byte_size,
      offset: output?.offset_bytes, nextOffset: output?.next_offset_bytes,
      bytes: bytes.length,
      sha256: [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2, '0')).join('')
    }
  })()`
  const record = await cdp.wait(expression, `persisted tool result from ${selected}`, 35_000)
  acceptance.persistedSkillEvidence[selected] = record
  assert.ok(record.callMatches && record.argumentsRedacted && record.resultMatches, 'Persisted tool receipt must match the exact Skill and resource without retaining raw arguments')
  assert.equal(record.offset, 0)
  assert.equal(record.nextOffset, null)
  assert.equal(record.bytes, pipelineBytes)
  assert.equal(record.declaredBytes, pipelineBytes)
  assert.equal(record.declaredTotalBytes, pipelineBytes)
  assert.equal(record.sha256, pipelineSha256, 'Persisted full original matches the official locked Skill archive')
}

export async function verifyWindowsComposerAcceptance(cdp, { workspace, acceptance, checkpoint = async () => {} }) {
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const files = { scan: join(workspace, scanName), text: join(workspace, textName), invalid: join(workspace, invalidName) }
  const scan = expandScanPdf(await readFile(new URL('../test/fixtures/document-quality/synthetic-image-only-scan.pdf', import.meta.url)))
  await Promise.all([writeFile(files.scan, scan), writeFile(files.text, createChineseTextPdf()), writeFile(files.invalid, '%PDF-1.7\ninvalid\n%%EOF\n')])
  const threadList = "window.workwise.runtimeRequest('/v1/threads','GET').then(result=>JSON.parse(result.body).threads)"
  const previousThreads = (await cdp.evaluate(threadList)).map(thread => thread.id)
  await cdp.click('.ds-sidebar-shell button.w-full', '新建会话')
  await cdp.wait(`Boolean(document.querySelector(${literal(composer)}))`, 'the real chat composer')
  const threadId = await cdp.wait(`${threadList}.then(items=>items.find(item=>!${literal(previousThreads)}.includes(item.id))?.id)`, 'new owned conversation')
  await cdp.click(composer)
  await checkpoint('composer native clipboard and scanned PDF')
  // Explorer's file clipboard format is set natively in the isolated runner.
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; [void]$files.Add(${psQuote(files.scan)}); [System.Windows.Forms.Clipboard]::SetFileDropList($files)`],
  { windowsHide: true, timeout: 15_000 })
  await key(cdp, 'v', 'KeyV', 86, 2)
  await cdp.wait(`document.body.innerText.includes(${literal(scanName)}) && document.body.innerText.includes('未提取')`, 'native pasted scanned PDF marked as missing text', 120_000)
  await cdp.click(sendButton)
  await continueAfterResponse(cdp, '扫描 PDF 原件已送达')

  await checkpoint('composer file chooser and Chinese PDF')
  // The chooser button runs the normal application handler. CDP fills the
  // actual native file input instead of scripting the desktop file dialog.
  await cdp.click(addMenu)
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true })
  await cdp.click('button', '添加文件或图片')
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' })
  assert.ok(nodeId)
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [files.text] })
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false })
  await cdp.wait(`(() => {
    const chip = [...document.querySelectorAll('.ds-floating-composer span')].find(item=>item.textContent.trim()===${literal(textName)})?.parentElement
    return Boolean(chip && /已就绪|文字提取受限/.test(chip.innerText) && chip.querySelector('[aria-label="在文件夹中显示原件"]'))
  })()`, 'text PDF loaded through the chooser', 120_000)
  await cdp.click(sendButton)
  await continueAfterResponse(cdp, '中文 PDF 文字已送达')

  await checkpoint('composer drag and invalid PDF')
  const point = await cdp.evaluate(`(() => { const r = document.querySelector(${literal(composer)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
  const drag = { ...point, data: { items: [], files: [files.invalid], dragOperationsMask: 1 } }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...drag })
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...drag })
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...drag })
  await cdp.wait(`(() => {
    const chip = [...document.querySelectorAll('.ds-floating-composer span')].find(item=>item.textContent.trim()===${literal(invalidName)})?.parentElement
    return Boolean(chip && chip.innerText.includes('读取失败'))
  })()`, 'damaged PDF feedback from the real drop', 120_000)
  await cdp.click(removeAttachment)

  await checkpoint('composer official Skill package')
  const installed = await cdp.evaluate(`(async () => {
    const catalog = await window.workwise.listCatalogPackages()
    const entry = catalog.packages.find(item => item.package.id === 'video-shotcraft')
    const prepared = await window.workwise.prepareCatalogPlugin({sourceId:entry.sourceId,packageId:entry.package.id})
    return await window.workwise.installPreparedPlugin({
      preparedId:prepared.id,reviewSha256:prepared.reviewSha256,expectedCurrentVersion:null,scope:'user',
      permissions:prepared.package.permissions.map(item=>({permissionId:item.id,decision:'denied'})),
      idempotencyKey: ${literal(randomUUID())}
    })
  })()`, 360_000)
  assert.equal(installed.packageId, 'video-shotcraft')
  const skill = await cdp.wait(`window.workwise.runtimeRequest(${literal(`/v1/skills?${new URLSearchParams({ scope: 'available', workspace })}`)},'GET').then(result=>result.ok&&JSON.parse(result.body).skills.find(item=>item.name==='video-shotcraft'))`, 'installed Video Shotcraft loaded by KUN', 90_000)
  acceptance.setSkillId(skill.id)
  const plugin = await cdp.wait(`window.workwise.runtimeRequest('/v1/capabilities/callable','POST',${literal(literal({ threadId, mode: 'agent' }))})
    .then(result=>result.ok&&JSON.parse(result.body).choices.find(item=>item.kind==='plugin'&&item.id==='video-shotcraft'))`, 'plugin callable in the selected conversation')

  await checkpoint('composer Skill selection and real readback')
  await cdp.fill(composer, `${acceptance.skillTurnMarker} 请读取分镜流程说明。`)
  await cdp.click(addMenu)
  await cdp.click('button', '技能')
  await cdp.click('[role="option"] .truncate', skill.name)
  await cdp.wait(`document.querySelector(${literal(composer)})?.value.includes(${literal(`/skill:${skill.id}`)})`, 'the exact inserted skill ID in the existing draft')
  await cdp.click(sendButton)
  await continueAfterResponse(cdp, '技能读取验收通过')
  await verifyPersistedSkillRead(cdp, threadId, 'skillRead', acceptance.skillTurnMarker, skill.id, acceptance)

  await checkpoint('composer plugin selection and real readback')
  await cdp.fill(composer, `${acceptance.pluginTurnMarker} 请读取插件分镜说明。`)
  await cdp.click(addMenu)
  await cdp.click('button', '插件与连接器')
  await cdp.click('[role="option"] .truncate', plugin.label)
  await cdp.click(sendButton)
  await continueAfterResponse(cdp, '插件读取验收通过')
  await verifyPersistedSkillRead(cdp, threadId, 'pluginRead', acceptance.pluginTurnMarker, skill.id, acceptance)
  assert.deepEqual(acceptance.observations, { skillRead: true, pluginRead: true, scanSent: true, chineseTextSent: true })
  return { status: 'passed', scanBytes: scan.length, nativeClipboard: true, chooser: true, drop: true,
    installedPlugin: { id: installed.packageId, sha256: installed.artifact.sha256 }, ...acceptance.observations }
}
