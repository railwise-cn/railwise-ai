import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DESIGN_CANVAS_FORMAT,
  DESIGN_CANVAS_FORMATS,
  DESIGN_CANVAS_PRESETS,
  DESIGN_DOCUMENT_LIMITS,
  DESIGN_ELEMENT_TYPES,
  canvasSizeForFormat,
  createDesignDocument,
  createDesignElement,
  createDesignPage,
  formatSvgColor,
  generateDesignElementId,
  generateDesignPageId,
  isValidDesignColor,
  nextZIndex,
  normalizeDesignDocument,
  normalizeDesignElement,
  validateDesignDocumentResourceLimits,
  type DesignDocumentV1,
  type DesignElement
} from './design-document'

describe('画布格式预设', () => {
  it('DESIGN_CANVAS_PRESETS 覆盖除 custom 外的所有格式', () => {
    const presetFormats = DESIGN_CANVAS_PRESETS.map((p) => p.format)
    const nonCustomFormats = DESIGN_CANVAS_FORMATS.filter((f) => f !== 'custom')
    expect(presetFormats.sort()).toEqual([...nonCustomFormats].sort())
  })

  it('每个预设的尺寸都是正整数', () => {
    for (const preset of DESIGN_CANVAS_PRESETS) {
      expect(preset.width).toBeGreaterThan(0)
      expect(preset.height).toBeGreaterThan(0)
      expect(Number.isInteger(preset.width)).toBe(true)
      expect(Number.isInteger(preset.height)).toBe(true)
    }
  })

  it('canvasSizeForFormat 返回预设尺寸', () => {
    expect(canvasSizeForFormat('ppt169')).toEqual({ width: 1280, height: 720 })
    expect(canvasSizeForFormat('ppt43')).toEqual({ width: 1024, height: 768 })
    expect(canvasSizeForFormat('a4')).toEqual({ width: 794, height: 1123 })
  })

  it('canvasSizeForFormat custom 用传入尺寸', () => {
    expect(canvasSizeForFormat('custom', { width: 800, height: 600 })).toEqual({ width: 800, height: 600 })
  })

  it('canvasSizeForFormat custom 无尺寸时回退默认', () => {
    expect(canvasSizeForFormat('custom')).toEqual({ width: 1280, height: 720 })
  })

  it('canvasSizeForFormat custom 尺寸取整且最小为 1', () => {
    expect(canvasSizeForFormat('custom', { width: 100.7, height: 0 })).toEqual({ width: 101, height: 1 })
  })

  it('canvasSizeForFormat custom 拒绝无限尺寸', () => {
    expect(canvasSizeForFormat('custom', {
      width: Number.POSITIVE_INFINITY,
      height: Number.NaN
    })).toEqual({ width: 1280, height: 720 })
  })
})

describe('元素类型', () => {
  it('包含 8 种基础类型', () => {
    expect(DESIGN_ELEMENT_TYPES).toHaveLength(8)
    expect(DESIGN_ELEMENT_TYPES).toContain('rect')
    expect(DESIGN_ELEMENT_TYPES).toContain('ellipse')
    expect(DESIGN_ELEMENT_TYPES).toContain('line')
    expect(DESIGN_ELEMENT_TYPES).toContain('path')
    expect(DESIGN_ELEMENT_TYPES).toContain('text')
    expect(DESIGN_ELEMENT_TYPES).toContain('image')
    expect(DESIGN_ELEMENT_TYPES).toContain('preset')
    expect(DESIGN_ELEMENT_TYPES).toContain('group')
  })
})

describe('createDesignElement 工厂', () => {
  it('矩形：默认 fill + 几何', () => {
    const el = createDesignElement('rect')
    expect(el.type).toBe('rect')
    expect(el.id).toMatch(/^el_/)
    expect(el.w).toBeGreaterThan(0)
    expect(el.h).toBeGreaterThan(0)
    expect(el.fill).toBeDefined()
    expect(el.fill).toMatch(/^[0-9A-Fa-f]{6}$/)
  })

  it('文字：默认 text + fontSize + fontFamily', () => {
    const el = createDesignElement('text')
    expect(el.type).toBe('text')
    expect(el.text).toBeDefined()
    expect(el.fontSize).toBeGreaterThan(0)
    expect(el.fontFamily).toBeDefined()
  })

  it('线条：默认 stroke + strokeWidth，无 fill', () => {
    const el = createDesignElement('line')
    expect(el.type).toBe('line')
    expect(el.stroke).toBeDefined()
    expect(el.strokeWidth).toBeGreaterThan(0)
    expect(el.fill).toBeUndefined()
  })

  it('图片：无 fill', () => {
    const el = createDesignElement('image')
    expect(el.type).toBe('image')
    expect(el.fill).toBeUndefined()
  })

  it('路径：默认 pathData + stroke，无 fill', () => {
    const el = createDesignElement('path')
    expect(el.type).toBe('path')
    expect(el.pathData).toBeDefined()
    expect(el.stroke).toBeDefined()
    expect(el.strokeWidth).toBeGreaterThan(0)
    expect(el.fill).toBeUndefined()
  })

  it('预设：默认 presetName', () => {
    const el = createDesignElement('preset')
    expect(el.type).toBe('preset')
    expect(el.presetName).toBeDefined()
  })

  it('分组：默认空 childIds + 无 fill', () => {
    const el = createDesignElement('group')
    expect(el.type).toBe('group')
    expect(el.childIds).toEqual([])
    expect(el.fill).toBeUndefined()
  })

  it('overrides 覆盖默认值', () => {
    const el = createDesignElement('rect', { x: 500, y: 300, fill: 'FF0000' })
    expect(el.x).toBe(500)
    expect(el.y).toBe(300)
    expect(el.fill).toBe('FF0000')
  })

  it('每个元素 id 唯一', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(createDesignElement('rect').id)
    }
    expect(ids.size).toBe(100)
  })
})

describe('createDesignPage 工厂', () => {
  it('默认格式 ppt169 → 1280×720', () => {
    const page = createDesignPage()
    expect(page.width).toBe(1280)
    expect(page.height).toBe(720)
    expect(page.elements).toEqual([])
    expect(page.background).toBeDefined()
  })

  it('指定格式用对应尺寸', () => {
    const page = createDesignPage({ format: 'social-square' })
    expect(page.width).toBe(1080)
    expect(page.height).toBe(1080)
  })

  it('custom 格式用自定义尺寸', () => {
    const page = createDesignPage({ format: 'custom', customSize: { width: 500, height: 500 } })
    expect(page.width).toBe(500)
    expect(page.height).toBe(500)
  })

  it('does not collide when pages, elements and documents are created in the same millisecond', () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      for (const create of [createDesignPage, () => createDesignElement('rect'), createDesignDocument]) {
        const ids = Array.from({ length: 50 }, () => create().id)
        expect(new Set(ids).size).toBe(50)
      }
    } finally { time.mockRestore(); random.mockRestore() }
  })
})

describe('createDesignDocument 工厂', () => {
  it('默认创建含一页的文档', () => {
    const doc = createDesignDocument()
    expect(doc.schemaVersion).toBe('v1')
    expect(doc.pages).toHaveLength(1)
    expect(doc.pages[0].elements).toEqual([])
    expect(doc.format).toBe(DEFAULT_DESIGN_CANVAS_FORMAT)
    expect(doc.assets).toEqual([])
    expect(doc.appliedCommands).toEqual([])
    expect(doc.createdAt).toBeGreaterThan(0)
    expect(doc.updatedAt).toBeGreaterThan(0)
  })

  it('指定格式时页面用对应尺寸', () => {
    const doc = createDesignDocument({ format: 'a4' })
    expect(doc.format).toBe('a4')
    expect(doc.pages[0].width).toBe(794)
    expect(doc.pages[0].height).toBe(1123)
  })
})

describe('isValidDesignColor', () => {
  it('合法 6 位 hex', () => {
    expect(isValidDesignColor('1E3A5F')).toBe(true)
    expect(isValidDesignColor('FFFFFF')).toBe(true)
    expect(isValidDesignColor('000000')).toBe(true)
    expect(isValidDesignColor('ffffff')).toBe(true)
  })

  it('拒绝带 # 的', () => {
    expect(isValidDesignColor('#1E3A5F')).toBe(false)
  })

  it('拒绝非 6 位', () => {
    expect(isValidDesignColor('1E3A5')).toBe(false)
    expect(isValidDesignColor('1E3A5FF')).toBe(false)
  })

  it('拒绝非 hex 字符', () => {
    expect(isValidDesignColor('1E3A5G')).toBe(false)
    expect(isValidDesignColor('Red')).toBe(false)
  })
})

describe('normalizeDesignElement - 防御性归一化', () => {
  it('完整合法元素原样保留', () => {
    const original = createDesignElement('rect', { x: 10, y: 20, fill: 'FF0000' })
    const result = normalizeDesignElement(original)
    expect(result).not.toBeNull()
    expect(result?.id).toBe(original.id)
    expect(result?.x).toBe(10)
    expect(result?.fill).toBe('FF0000')
  })

  it('null/undefined 返回 null', () => {
    expect(normalizeDesignElement(null)).toBeNull()
    expect(normalizeDesignElement(undefined)).toBeNull()
  })

  it('缺 id 返回 null', () => {
    expect(normalizeDesignElement({ type: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, zIndex: 0 })).toBeNull()
  })

  it('缺 type 返回 null', () => {
    expect(normalizeDesignElement({ id: 'el_1', x: 0, y: 0, w: 10, h: 10, rotation: 0, zIndex: 0 })).toBeNull()
  })

  it('非法 type 返回 null', () => {
    expect(normalizeDesignElement({ id: 'el_1', type: 'unknown' as any, x: 0, y: 0, w: 10, h: 10, rotation: 0, zIndex: 0 })).toBeNull()
  })

  it('缺几何字段时补默认值', () => {
    const result = normalizeDesignElement({ id: 'el_1', type: 'rect', rotation: 0, zIndex: 0 })
    expect(result).not.toBeNull()
    expect(result?.x).toBe(0)
    expect(result?.y).toBe(0)
    expect(result?.w).toBe(100)
    expect(result?.h).toBe(100)
  })

  it('非法颜色被修正为 000000', () => {
    const result = normalizeDesignElement({
      id: 'el_1', type: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, zIndex: 0,
      fill: 'invalid'
    })
    expect(result?.fill).toBe('000000')
  })

  it('childIds 过滤非字符串', () => {
    const result = normalizeDesignElement({
      id: 'el_1', type: 'group', x: 0, y: 0, w: 10, h: 10, rotation: 0, zIndex: 0,
      childIds: ['el_a', 123, null, 'el_b']
    } as any)
    expect(result?.childIds).toEqual(['el_a', 'el_b'])
  })

  it('无限尺寸回退为安全默认值', () => {
    const result = normalizeDesignElement({
      id: 'el_1',
      type: 'rect',
      w: Number.POSITIVE_INFINITY,
      h: Number.NEGATIVE_INFINITY
    })
    expect(result?.w).toBe(100)
    expect(result?.h).toBe(100)
  })

  it('line 元素的负 w/h（向左/向上的方向）原样保留', () => {
    const result = normalizeDesignElement({
      id: 'el_line_up',
      type: 'line',
      x: 290,
      y: 530,
      w: 250,
      h: -50,
      stroke: '0F3D6E',
      strokeWidth: 2,
      rotation: 0,
      zIndex: 59
    })
    expect(result).not.toBeNull()
    expect(result?.w).toBe(250)
    expect(result?.h).toBe(-50)

    const leftward = normalizeDesignElement({
      id: 'el_line_left',
      type: 'line',
      x: 1000,
      y: 320,
      w: -260,
      h: 110,
      stroke: '0F3D6E',
      strokeWidth: 2,
      rotation: 0,
      zIndex: 71
    })
    expect(leftward?.w).toBe(-260)
    expect(leftward?.h).toBe(110)
  })

  it('line 元素 w/h 为 0 或非有限值时回退默认值', () => {
    const zero = normalizeDesignElement({
      id: 'el_line_zero',
      type: 'line',
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      rotation: 0,
      zIndex: 0
    })
    expect(zero?.w).toBe(100)
    expect(zero?.h).toBe(100)

    const nan = normalizeDesignElement({
      id: 'el_line_nan',
      type: 'line',
      x: 0,
      y: 0,
      w: Number.NaN,
      h: Number.POSITIVE_INFINITY,
      rotation: 0,
      zIndex: 0
    })
    expect(nan?.w).toBe(100)
    expect(nan?.h).toBe(100)
  })

  it('预设多路径保留顺序、颜色与显式 none', () => {
    const result = normalizeDesignElement({
      id: 'el_1',
      type: 'preset',
      presetPaths: [
        { d: 'M 0 0 L 10 10 Z', fill: 'FF0000' },
        { d: 'M 1 1 L 9 9 Z', fill: null, stroke: '000000', strokeWidth: 2 }
      ]
    })
    expect(result?.presetPaths).toEqual([
      { d: 'M 0 0 L 10 10 Z', fill: 'FF0000' },
      { d: 'M 1 1 L 9 9 Z', fill: null, stroke: '000000', strokeWidth: 2 }
    ])
  })
})

describe('normalizeDesignDocument - 防御性归一化', () => {
  it('完整文档原样保留核心结构', () => {
    const doc = createDesignDocument({ name: '测试文档' })
    doc.pages[0].elements.push(createDesignElement('rect'))
    doc.revision = 3
    doc.appliedCommands = [{
      idempotencyKey: 'turn-1-command-1',
      revision: 3,
      appliedOperations: 1
    }]
    const result = normalizeDesignDocument(doc)
    expect(result).not.toBeNull()
    expect(result?.name).toBe('测试文档')
    expect(result?.pages).toHaveLength(1)
    expect(result?.pages[0].elements).toHaveLength(1)
    expect(result?.appliedCommands).toEqual(doc.appliedCommands)
  })

  it('旧文档缺少命令记录时安全迁移，损坏或重复的记录会拒绝', () => {
    const legacy = createDesignDocument()
    delete (legacy as Partial<DesignDocumentV1>).appliedCommands
    expect(normalizeDesignDocument(legacy)?.appliedCommands).toEqual([])

    const invalid = createDesignDocument()
    invalid.appliedCommands = [
      { idempotencyKey: 'same', revision: 0, appliedOperations: 1 },
      { idempotencyKey: 'same', revision: 0, appliedOperations: 1 }
    ]
    expect(normalizeDesignDocument(invalid)).toBeNull()
  })

  it('null/undefined 返回 null', () => {
    expect(normalizeDesignDocument(null)).toBeNull()
    expect(normalizeDesignDocument(undefined)).toBeNull()
  })

  it('无 pages 返回 null', () => {
    expect(normalizeDesignDocument({ schemaVersion: 'v1', id: 'x', name: 'x', format: 'ppt169', pages: [], assets: [] })).toBeNull()
  })

  it('损坏的 page 被跳过，合法的保留', () => {
    const validPage = createDesignPage()
    const result = normalizeDesignDocument({
      schemaVersion: 'v1',
      id: 'doc_1',
      name: 'x',
      format: 'ppt169',
      pages: [
        null as any,
        { id: '', name: '坏页' }, // 缺 id
        validPage
      ],
      assets: []
    })
    expect(result?.pages).toHaveLength(1)
    expect(result?.pages[0].id).toBe(validPage.id)
  })

  it('损坏的 element 被跳过', () => {
    const page = createDesignPage()
    const validElement = createDesignElement('rect')
    page.elements = [
      null as any,
      { type: 'rect', x: 0 } as any, // 缺 id
      validElement
    ]
    const result = normalizeDesignDocument({
      schemaVersion: 'v1',
      id: 'doc_1',
      name: 'x',
      format: 'ppt169',
      pages: [page],
      assets: []
    })
    expect(result?.pages[0].elements).toHaveLength(1)
    expect(result?.pages[0].elements[0].id).toBe(validElement.id)
  })

  it('非法 format 回退默认', () => {
    const page = createDesignPage()
    const result = normalizeDesignDocument({
      schemaVersion: 'v1',
      id: 'doc_1',
      name: 'x',
      format: 'invalid-format' as any,
      pages: [page],
      assets: []
    })
    expect(result?.format).toBe(DEFAULT_DESIGN_CANVAS_FORMAT)
  })

  it('页面尺寸取整', () => {
    const result = normalizeDesignDocument({
      schemaVersion: 'v1',
      id: 'doc_1',
      name: 'x',
      format: 'ppt169',
      pages: [{ id: 'p1', name: 'P', width: 100.7, height: 200.3, elements: [] }],
      assets: []
    })
    expect(result?.pages[0].width).toBe(101)
    expect(result?.pages[0].height).toBe(200)
  })

  it('无限页面尺寸回退为默认画布', () => {
    const page = createDesignPage()
    page.width = Number.POSITIVE_INFINITY
    page.height = Number.NaN
    const result = normalizeDesignDocument({
      schemaVersion: 'v1',
      id: 'doc_1',
      name: 'x',
      format: 'custom',
      pages: [page],
      assets: []
    })
    expect(result?.pages[0].width).toBe(1280)
    expect(result?.pages[0].height).toBe(720)
  })

  it('assets 过滤缺 id/filename 的', () => {
    const result = normalizeDesignDocument({
      schemaVersion: 'v1',
      id: 'doc_1',
      name: 'x',
      format: 'ppt169',
      pages: [createDesignPage()],
      assets: [
        { id: 'a1', filename: 'img.png', mimeType: 'image/png', width: 100, height: 100, byteSize: 5000 },
        { id: '', filename: 'bad.png', mimeType: 'image/png', width: 100, height: 100, byteSize: 5000 },
        { id: 'a2', filename: '', mimeType: 'image/png', width: 100, height: 100, byteSize: 5000 }
      ]
    })
    expect(result?.assets).toHaveLength(1)
    expect(result?.assets[0].id).toBe('a1')
  })
})

describe('id 生成器格式', () => {
  it('generateDesignElementId 格式', () => {
    expect(generateDesignElementId()).toMatch(/^el_/)
  })

  it('generateDesignPageId 格式', () => {
    expect(generateDesignPageId()).toMatch(/^page_/)
  })
})

describe('画布尺寸自由（架构核心约束回归保护）', () => {
  it('custom 格式支持任意正整数尺寸', () => {
    // 这是架构文档修正后的核心约束：不强制 1280×720
    const odd1 = createDesignPage({ format: 'custom', customSize: { width: 1, height: 1 } })
    expect(odd1.width).toBe(1)
    expect(odd1.height).toBe(1)

    const odd2 = createDesignPage({ format: 'custom', customSize: { width: 99999, height: 99999 } })
    expect(odd2.width).toBe(99999)
    expect(odd2.height).toBe(99999)
  })

  it('所有预设尺寸互不相同（非全部 16:9）', () => {
    const sizes = DESIGN_CANVAS_PRESETS.map((p) => `${p.width}x${p.height}`)
    const unique = new Set(sizes)
    expect(unique.size).toBe(sizes.length)
  })

  it('文档可包含不同尺寸的页面', () => {
    // 多页文档各页可独立尺寸（为 PPT 混合比例/设计变体留路）
    const doc = createDesignDocument()
    doc.pages.push(createDesignPage({ format: 'social-square' }))
    expect(doc.pages[0].width).toBe(1280)
    expect(doc.pages[1].width).toBe(1080)
    expect(doc.pages[1].height).toBe(1080)
  })
})

describe('nextZIndex - z 序分配', () => {
  it('空列表返回 0', () => {
    expect(nextZIndex([])).toBe(0)
  })

  it('返回当前最大 zIndex + 1', () => {
    const elements = [
      createDesignElement('rect', { zIndex: 0 }),
      createDesignElement('rect', { zIndex: 2 }),
      createDesignElement('rect', { zIndex: 1 })
    ]
    expect(nextZIndex(elements)).toBe(3)
  })

  it('负 zIndex 不影响（取最大值）', () => {
    const elements = [
      createDesignElement('rect', { zIndex: -5 }),
      createDesignElement('rect', { zIndex: 3 })
    ]
    expect(nextZIndex(elements)).toBe(4)
  })

  it('新元素 zIndex 唯一递增（模拟连续创建）', () => {
    const elements: DesignElement[] = []
    for (let i = 0; i < 5; i++) {
      const z = nextZIndex(elements)
      elements.push(createDesignElement('rect', { zIndex: z }))
    }
    const zIndices = elements.map((e) => e.zIndex)
    expect(zIndices).toEqual([0, 1, 2, 3, 4])
    expect(new Set(zIndices).size).toBe(5) // 全唯一
  })
})

describe('formatSvgColor - SVG 颜色格式化', () => {
  it('合法颜色补 #', () => {
    expect(formatSvgColor('1E3A5F')).toBe('#1E3A5F')
    expect(formatSvgColor('FFFFFF')).toBe('#FFFFFF')
    expect(formatSvgColor('000000')).toBe('#000000')
  })

  it('undefined 透传', () => {
    expect(formatSvgColor(undefined)).toBeUndefined()
  })

  it('非法颜色回退黑色', () => {
    expect(formatSvgColor('invalid')).toBe('#000000')
    expect(formatSvgColor('XYZ')).toBe('#000000')
  })

  it('大小写保留（内部存储的原始大小写）', () => {
    expect(formatSvgColor('abcdef')).toBe('#abcdef')
    expect(formatSvgColor('ABCDEF')).toBe('#ABCDEF')
  })
})

describe('Design document resource limits', () => {
  it('accepts the page-count boundary and rejects one page above it', () => {
    const document = createDesignDocument()
    document.pages = Array.from({ length: DESIGN_DOCUMENT_LIMITS.pages }, (_, index) => ({
      id: `page_${index}`,
      name: `Page ${index + 1}`,
      width: 1280,
      height: 720,
      elements: []
    }))
    expect(validateDesignDocumentResourceLimits(document).ok).toBe(true)

    document.pages.push({
      id: 'page_over',
      name: 'Over',
      width: 1280,
      height: 720,
      elements: []
    })
    expect(validateDesignDocumentResourceLimits(document)).toMatchObject({
      ok: false,
      message: expect.stringContaining(String(DESIGN_DOCUMENT_LIMITS.pages))
    })
  })

  it('accepts the per-page element boundary and rejects one element above it', () => {
    const document = createDesignDocument()
    document.pages[0].elements = Array.from(
      { length: DESIGN_DOCUMENT_LIMITS.elementsPerPage },
      (_, index) => createDesignElement('rect', { id: `el_${index}` })
    )
    expect(validateDesignDocumentResourceLimits(document).ok).toBe(true)

    document.pages[0].elements.push(
      createDesignElement('rect', { id: 'el_over' })
    )
    expect(validateDesignDocumentResourceLimits(document)).toMatchObject({
      ok: false,
      message: expect.stringContaining(String(DESIGN_DOCUMENT_LIMITS.elementsPerPage))
    })
  })

  it('rejects oversized element strings and deeply nested unknown fields', () => {
    const document = createDesignDocument()
    document.pages[0].elements.push(
      createDesignElement('text', {
        text: 'x'.repeat(DESIGN_DOCUMENT_LIMITS.textChars + 1)
      })
    )
    expect(validateDesignDocumentResourceLimits(document)).toMatchObject({
      ok: false,
      message: expect.stringContaining('256 Ki')
    })

    let nested: Record<string, unknown> = {}
    const root = nested
    for (let depth = 0; depth <= DESIGN_DOCUMENT_LIMITS.nestingDepth; depth += 1) {
      const next: Record<string, unknown> = {}
      nested.child = next
      nested = next
    }
    expect(validateDesignDocumentResourceLimits({
      ...createDesignDocument(),
      metadata: root
    })).toMatchObject({
      ok: false,
      message: expect.stringContaining('nesting')
    })
  })

  it('rejects a compact serialized document one byte over the 8 MiB budget', () => {
    const document = {
      ...createDesignDocument(),
      metadata: Array.from(
        { length: 33 },
        () => 'x'.repeat(DESIGN_DOCUMENT_LIMITS.genericStringChars)
      )
    }
    expect(validateDesignDocumentResourceLimits(document)).toMatchObject({
      ok: false,
      message: expect.stringContaining('8 MiB')
    })
  })
})
