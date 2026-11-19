import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { psQuote } from './run-windows-published-gui-update-smoke.mjs'

const literal = JSON.stringify
const composer = 'textarea[placeholder="向智能体提问…"]:not(:disabled)'
const addMenu = 'button[aria-label="更多操作"]'
const sendButton = 'button[aria-label="发送"]:not(:disabled)'
const removeAttachment = 'button[aria-label="移除附件"]'
const fontMap = '铁路合成验收'
const textName = '中文文字样本.pdf'
const scanName = '扫描宣传册.pdf'
const invalidName = '损坏样本.pdf'

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

export function createComposerModelAcceptance() {
  const observations = { skillRead: false, pluginRead: false, scanSent: false, chineseTextSent: false }
  const skillTurnMarker = `railwise-skill-check-${randomUUID()}`
  const pluginTurnMarker = `railwise-plugin-check-${randomUUID()}`
  let skillId
  return {
    observations, skillTurnMarker, pluginTurnMarker,
    setSkillId(value) { skillId = value },
    modelAction(body) {
      const messages = body.messages ?? []
      const currentUser = [...messages].reverse().find(item => item.role === 'user')
      const text = literal(currentUser?.content ?? '')
      const history = literal(messages)
      const selected = text.includes(skillTurnMarker) ? 'skillRead' : text.includes(pluginTurnMarker) ? 'pluginRead' : null
      if (selected) {
        assert.ok(skillId)
        if (selected === 'pluginRead') {
          assert.ok(messages.some(item => typeof item.content === 'string' && item.content.includes('"kind":"plugin","id":"video-shotcraft"')))
        }
        const id = `composer-${selected}`
        const readback = messages.find(item => item.role === 'tool' && item.tool_call_id === id)
        if (readback) {
          assert.ok(literal(readback.content).includes('remotion render'), 'Real installed plugin documentation must be read')
          observations[selected] = true
          return { content: selected === 'pluginRead' ? '插件读取验收通过' : '技能读取验收通过' }
        }
        assert.ok(body.tools?.some(item => item.function?.name === 'read_skill_resource'))
        return { tool_calls: [{ index: 0, id, type: 'function',
          function: { name: 'read_skill_resource', arguments: literal({ skill_id: skillId, path: 'references/pipeline.md' }) } }] }
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
  await cdp.wait(`document.body.innerText.includes(${literal(message)}) && Boolean(document.querySelector(${literal(composer)}))`, message, 120_000)
}

export async function verifyWindowsComposerAcceptance(cdp, { workspace, acceptance }) {
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
  // Explorer's file clipboard format is set natively in the isolated runner.
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; [void]$files.Add(${psQuote(files.scan)}); [System.Windows.Forms.Clipboard]::SetFileDropList($files)`],
  { windowsHide: true, timeout: 15_000 })
  await key(cdp, 'v', 'KeyV', 86, 2)
  await cdp.wait(`document.body.innerText.includes(${literal(scanName)}) && document.body.innerText.includes('未提取')`, 'native pasted scanned PDF marked as missing text', 120_000)
  await cdp.click(sendButton)
  await continueAfterResponse(cdp, '扫描 PDF 原件已送达')

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

  await cdp.fill(composer, `${acceptance.skillTurnMarker} 请读取分镜流程说明。`)
  await cdp.click(addMenu)
  await cdp.click('button', '技能')
  await cdp.click('[role="option"] .truncate', skill.name)
  await cdp.wait(`document.querySelector(${literal(composer)})?.value.includes(${literal(`/skill:${skill.id}`)})`, 'the exact inserted skill ID in the existing draft')
  await cdp.click(sendButton)
  await continueAfterResponse(cdp, '技能读取验收通过')

  await cdp.fill(composer, `${acceptance.pluginTurnMarker} 请读取插件分镜说明。`)
  await cdp.click(addMenu)
  await cdp.click('button', '插件与连接器')
  await cdp.click('[role="option"] .truncate', plugin.label)
  await cdp.click(sendButton)
  await continueAfterResponse(cdp, '插件读取验收通过')
  assert.deepEqual(acceptance.observations, { skillRead: true, pluginRead: true, scanSent: true, chineseTextSent: true })
  return { status: 'passed', scanBytes: scan.length, nativeClipboard: true, chooser: true, drop: true,
    installedPlugin: { id: installed.packageId, sha256: installed.artifact.sha256 }, ...acceptance.observations }
}
