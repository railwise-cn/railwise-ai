/**
 * Design 工作区核心数据模型。
 *
 * 这是 renderer / main / preload 三层共享的单一数据源：
 * - 设计文档（DesignDocumentV1）、页面（DesignPage）、元素（DesignElement）
 * - 画布格式预设（DesignCanvasFormat）
 * - 元素类型枚举（DesignElementType）
 *
 * 坐标系：96dpi 像素，原点左上角，y 向下。
 * 与 PPT Master 的 canvas_contract.py 一致（✅ 已核实 canvas_contract.py:115-123）。
 *
 * 约束来源（✅ svg_quality_checker.py:330-424）：
 * - 颜色用 hex 无 #（如 '1E3A5F'），与 fill/opacity 分离（不用 rgba）
 * - 全 inline 属性，无 class/style
 * - 无 mask/foreignObject/SMIL 动画
 *
 * 画布尺寸：任意正整数像素（✅ canvas_contract.py 只要求原点 0,0 + 正数 + 落在
 * PowerPoint 1-56 inch 范围内）。1280×720 只是 ppt169 预设的默认值，不是硬约束。
 *
 * 架构详见 docs/DESIGN_WORKSPACE_ARCHITECTURE.md。
 */

// ---------------------------------------------------------------------------
// 画布格式预设
// ---------------------------------------------------------------------------

/**
 * 画布格式预设 key。
 * 每个对应一组默认尺寸（见 DESIGN_CANVAS_PRESETS）。
 * 'custom' 时用页面自定义的 width/height。
 */
export const DESIGN_CANVAS_FORMATS = [
  'ppt169',
  'ppt43',
  'a4',
  'poster-a2',
  'social-square',
  'social-story',
  'wechat-cover',
  'banner',
  'custom'
] as const

export type DesignCanvasFormat = (typeof DESIGN_CANVAS_FORMATS)[number]

/**
 * 画布尺寸预设表。
 *
 * 尺寸来源依据（✅ 已核实）：
 * - ppt169/ppt43：PPT Master config.py 的 CANVAS_FORMATS（1280×720 / 1024×768）
 * - a4：210×297mm @ 96dpi ≈ 794×1123px
 * - poster-a2：420×594mm @ 96dpi ≈ 1191×1684px
 * - social-square/social-story：Instagram/小红书常见尺寸
 * - wechat-cover：微信公众号封面常见尺寸
 * - banner：网页横幅常见尺寸
 */
export const DESIGN_CANVAS_PRESETS: ReadonlyArray<{
  format: Exclude<DesignCanvasFormat, 'custom'>
  width: number
  height: number
  labelKey: string
}> = [
  { format: 'ppt169', width: 1280, height: 720, labelKey: 'designFormatPpt169' },
  { format: 'ppt43', width: 1024, height: 768, labelKey: 'designFormatPpt43' },
  { format: 'a4', width: 794, height: 1123, labelKey: 'designFormatA4' },
  { format: 'poster-a2', width: 1191, height: 1684, labelKey: 'designFormatPosterA2' },
  { format: 'social-square', width: 1080, height: 1080, labelKey: 'designFormatSocialSquare' },
  { format: 'social-story', width: 1080, height: 1920, labelKey: 'designFormatSocialStory' },
  { format: 'wechat-cover', width: 900, height: 383, labelKey: 'designFormatWechatCover' },
  { format: 'banner', width: 1920, height: 600, labelKey: 'designFormatBanner' }
]

/** 默认格式（新建文档时） */
export const DEFAULT_DESIGN_CANVAS_FORMAT: DesignCanvasFormat = 'ppt169'

/**
 * Design 文档硬上限。
 *
 * 这些值同时供 renderer、IPC 与 main 持久化层使用。文档文件本身最多
 * 8 MiB；保存层仍会对最终 pretty-printed JSON（包含结尾换行）做一次
 * 精确校验，确保“保存成功”的文件一定能被读取层重新打开。
 */
export const DESIGN_DOCUMENT_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  pages: 256,
  elementsPerPage: 5_000,
  elementsTotal: 20_000,
  assets: 1_024,
  genericArrayItems: 20_000,
  genericObjectKeys: 128,
  genericContainers: 100_000,
  nestingDepth: 12,
  genericStringChars: 256 * 1024,
  idChars: 160,
  nameChars: 512,
  textChars: 256 * 1024,
  pathDataChars: 100_000,
  presetPathsPerElement: 256,
  childIdsPerGroup: 5_000,
  tokenValues: 1_024,
  fontFamilyChars: 512,
  fontWeightChars: 64,
  presetNameChars: 128
})

export type DesignDocumentLimitResult =
  | { ok: true; serializedBytes: number }
  | { ok: false; message: string }

export type DesignAppliedCommandRecord = {
  idempotencyKey: string
  revision: number
  appliedOperations: number
}

/**
 * 根据格式 key 获取预设尺寸。custom 格式返回 null（由调用方提供尺寸）。
 */
export function canvasSizeForFormat(
  format: DesignCanvasFormat,
  custom?: { width: number; height: number }
): { width: number; height: number } {
  if (format === 'custom') {
    const customWidth = Number.isFinite(custom?.width) ? custom!.width : 1280
    const customHeight = Number.isFinite(custom?.height) ? custom!.height : 720
    return {
      width: Math.max(1, Math.round(customWidth)),
      height: Math.max(1, Math.round(customHeight))
    }
  }
  const preset = DESIGN_CANVAS_PRESETS.find((p) => p.format === format)
  return preset
    ? { width: preset.width, height: preset.height }
    : { width: 1280, height: 720 }
}

// ---------------------------------------------------------------------------
// 元素类型
// ---------------------------------------------------------------------------

/**
 * 画布元素类型。每种对应一个 SVG 节点：
 * - rect → <rect>
 * - ellipse → <ellipse>
 * - line → <line>
 * - path → <path d>
 * - text → <text>
 * - image → <image href>
 * - preset → <g>（PPT Master 187 形状之一，由 preset_shape_svg.py 生成）
 * - group → <g>（子元素分组）
 *
 * 支持的 SVG 元素清单来源（✅ svg_to_pptx/drawingml_converter.py:244-256）。
 */
export const DESIGN_ELEMENT_TYPES = [
  'rect',
  'ellipse',
  'line',
  'path',
  'text',
  'image',
  'preset',
  'group'
] as const

export type DesignElementType = (typeof DESIGN_ELEMENT_TYPES)[number]

export type DesignPresetPath = {
  d: string
  /** undefined inherits the element paint; null explicitly means none. */
  fill?: string | null
  /** undefined inherits the element paint; null explicitly means none. */
  stroke?: string | null
  strokeWidth?: number
  opacity?: number
}

// ---------------------------------------------------------------------------
// 单个画布元素
// ---------------------------------------------------------------------------

/**
 * 单个画布元素。每个元素可直接渲染为一个 SVG 节点。
 *
 * 字段设计原则：
 * - 几何（x/y/w/h/rotation）：所有元素都有，数值为 96dpi 像素
 * - 样式（fill/stroke/opacity）：可选，全 inline 无 class
 * - 颜色：hex 无 # 字符串（如 '1E3A5F'），符合 svg_quality_checker 约束
 * - 类型特有属性放各自字段（text/imageSrc/presetName/pathData/childIds）
 */
export type DesignElement = {
  /** 元素 id，格式 'el_<时间戳><随机>'，文档内唯一 */
  id: string
  type: DesignElementType

  // 几何（96dpi 像素，左上原点）
  x: number
  y: number
  w: number
  h: number
  /** 旋转角度（度），0 为正，顺时针 */
  rotation: number

  // 样式（全可选，全 inline）
  /** 填充色，hex 无 #（如 '1E3A5F' */
  fill?: string
  /** 描边色，hex 无 # */
  stroke?: string
  /** 描边宽度（像素） */
  strokeWidth?: number
  /** 描边端点样式 */
  strokeLinecap?: 'butt' | 'round' | 'square'
  /** 描边拐角样式 */
  strokeLinejoin?: 'miter' | 'round' | 'bevel'
  /** 不透明度 0-1。注意：svg_quality_checker 禁止 <g opacity=> 和 rgba，
   *  导出器会把透明度施加到具体元素，而不是结构分组。 */
  opacity?: number

  // type=text 特有
  text?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: string
  textAlign?: 'left' | 'center' | 'right'
  /** 字间距（像素），对应 SVG letter-spacing */
  letterSpacing?: number

  // type=image 特有
  /** 图片资源 id（指向 document.assets），不是直接路径 */
  imageAssetId?: string

  // type=preset 特有
  /** PPT Master DrawingML 预设形状名（如 'rightArrow'）。
   *  取值来自 preset_shape_svg.py list（✅ 187 个，全 ASCII camelCase） */
  presetName?: string

  // type=path 特有
  /** SVG path d 属性值（如 'M10,10 L100,100'） */
  pathData?: string
  /** 复杂预设形状的有序多路径。pathData 继续保留首路径以兼容旧文档。 */
  presetPaths?: DesignPresetPath[]

  // type=group 特有
  /** 子元素 id 列表（文档内引用） */
  childIds?: string[]

  // 通用元数据
  /** 图层面板显示名。缺省时用 type + 序号 */
  name?: string
  /** z 序（越大越在上）。同一文档内唯一性由 store 维护 */
  zIndex: number
  /** 锁定（不可选中/编辑） */
  locked?: boolean
  /** 隐藏（不渲染） */
  hidden?: boolean
}

// ---------------------------------------------------------------------------
// 单页画布
// ---------------------------------------------------------------------------

/**
 * 单页画布，对应一张幻灯片/一张图。
 * 一个文档可有多个页面（多页设计/PPT）。
 */
export type DesignPage = {
  id: string
  /** 页面名（如 'slide_01_cover'）。缺省用 'Page N' */
  name: string
  /** 画布宽度（96dpi 像素，任意正整数） */
  width: number
  /** 画布高度（96dpi 像素，任意正整数） */
  height: number
  /** 页面元素列表（按 zIndex 排序渲染） */
  elements: DesignElement[]
  /** 背景色（hex 无 #）。缺省透明或白 */
  background?: string
  /** 整页参考图资源 id（导入 PPT 时生成），用于“视觉保真”模式 */
  fidelityImageAssetId?: string
  /** 页面显示模式：editable=矢量元素可编辑；fidelity=整页参考图（视觉保真） */
  displayMode?: 'editable' | 'fidelity'
}

// ---------------------------------------------------------------------------
// 资源（图片等）
// ---------------------------------------------------------------------------

/**
 * 文档资源（主要是图片）。
 * 资源文件存在文档目录的 assets/ 下，元素通过 imageAssetId 引用。
 */
export type DesignAsset = {
  id: string
  /** 文件名（在文档专属 assets/ 目录下，如 'cover.png'；不得包含路径分隔符） */
  filename: string
  mimeType: string
  /** 原始像素尺寸（用于等比缩放计算） */
  width: number
  height: number
  /** 文件字节大小（用于限制/校验） */
  byteSize: number
}

// ---------------------------------------------------------------------------
// 设计文档
// ---------------------------------------------------------------------------

/**
 * 完整设计文档。序列化为 JSON 存盘。
 *
 * 序列化路径：
 * - 存盘：DesignDocumentV1 JSON + assets/ 图片 → <workspace>/.workwise/design/
 * - SVG 渲染：每页 elements → SVG 节点（CanvasView 组件）
 * - 导出 PPTX：每页 → <svg viewBox="0 0 W H"> → svg_to_pptx.py
 */
export type DesignDocumentV1 = {
  schemaVersion: 'v1'
  id: string
  /**
   * 单调递增的内容 revision。任何可持久化画板变更必须递增，
   * main 进程用它和 expectedRevision 一起阻止旧 renderer 覆盖新数据。
   */
  revision: number
  /** 文档名（也是项目目录名） */
  name: string
  /** 画布格式（新建文档时选，影响默认尺寸）。custom 时各页可不同尺寸 */
  format: DesignCanvasFormat
  /** 页面列表 */
  pages: DesignPage[]
  /** 资源列表 */
  assets: DesignAsset[]
  /**
   * 最近成功应用的 Agent 画板命令。它随文档持久化且不受 undo/redo 回滚，
   * 使运行时重放同一命令时可以返回原始确认而不会再次修改画板。
   */
  appliedCommands: DesignAppliedCommandRecord[]
  /** 可选设计 Token（颜色、字体和间距规范） */
  designTokens?: {
    colors?: string[]
    fonts?: string[]
    spacing?: number[]
  }
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// 工厂函数与工具
// ---------------------------------------------------------------------------

/** 生成元素 id */
export function generateDesignElementId(): string {
  return `el_${crypto.randomUUID()}`
}

/** 生成页面 id */
export function generateDesignPageId(): string {
  return `page_${crypto.randomUUID()}`
}

/** 生成文档 id */
export function generateDesignDocumentId(): string {
  return `doc_${crypto.randomUUID()}`
}

/**
 * 计算下一个可用的 zIndex（当前最大值 + 1）。
 * 用于创建新元素时分配 z 序，保证新元素在最上层。
 * 空列表时返回 0。
 */
export function nextZIndex(elements: ReadonlyArray<DesignElement>): number {
  let max = -1
  for (const el of elements) {
    if (typeof el.zIndex === 'number' && el.zIndex > max) max = el.zIndex
  }
  return max + 1
}

/**
 * 把内部颜色（hex 无 #，如 '1E3A5F'）格式化为 SVG 属性值（带 #，如 '#1E3A5F'）。
 *
 * 渲染 SVG 时必须用此函数：SVG 规范要求 fill/stroke 属性带 #（如 fill="#1E3A5F"），
 * 但数据模型内部存无 # 格式（便于比较/存储，也与 svg_to_pptx 的 parse_svg_color
 * 兼容——它对 # 可有可无，见 utils.py:1650）。
 *
 * 非法颜色回退为 '#000000'（黑），避免渲染出 malformed SVG。
 */
export function formatSvgColor(internalColor: string | undefined): string | undefined {
  if (internalColor === undefined) return undefined
  if (isValidDesignColor(internalColor)) return `#${internalColor}`
  return '#000000'
}

/**
 * 创建一个默认元素（指定类型，其余用合理初始值）。
 * 用于工具栏点击"添加矩形/圆/文字"等场景。
 */
export function createDesignElement(
  type: DesignElementType,
  overrides: Partial<DesignElement> = {}
): DesignElement {
  const base: DesignElement = {
    id: generateDesignElementId(),
    type,
    x: 100,
    y: 100,
    w: 200,
    h: 120,
    rotation: 0,
    fill: '1E3A5F',
    zIndex: 0,
    ...overrides
  }
  // 类型特有默认值
  if (type === 'text') {
    base.text = overrides.text ?? '文本'
    base.fontSize = overrides.fontSize ?? 24
    base.fontFamily = overrides.fontFamily ?? "system-ui, 'Microsoft YaHei', sans-serif"
    base.fontWeight = overrides.fontWeight ?? 'normal'
    // 显式传入 undefined 表示“无填充”（例如 SVG fill="none"），不得回退默认色
    base.fill = 'fill' in overrides ? overrides.fill : '1A1A2E'
  }
  if (type === 'ellipse') {
    base.fill = 'fill' in overrides ? overrides.fill : '4A90D9'
  }
  if (type === 'line') {
    base.stroke = overrides.stroke ?? '1A1A2E'
    base.strokeWidth = overrides.strokeWidth ?? 2
    base.fill = undefined
  }
  if (type === 'image') {
    base.fill = undefined
  }
  if (type === 'path') {
    base.pathData = overrides.pathData ?? 'M0,0 L100,0 L100,100 L0,100 Z'
    if (overrides.fill === undefined && overrides.stroke === undefined) {
      base.fill = undefined
      base.stroke = 'C41E3A'
      base.strokeWidth = overrides.strokeWidth ?? 2
    } else {
      base.fill = overrides.fill
      base.stroke = overrides.stroke
      base.strokeWidth = overrides.strokeWidth
    }
  }
  if (type === 'preset') {
    base.presetName = overrides.presetName ?? 'rect'
    base.fill = overrides.fill ?? '1E3A5F'
  }
  if (type === 'group') {
    base.childIds = overrides.childIds ?? []
    base.fill = undefined
  }
  return base
}

/**
 * 创建一个默认页面（指定格式或自定义尺寸）。
 */
export function createDesignPage(options?: {
  format?: DesignCanvasFormat
  customSize?: { width: number; height: number }
  name?: string
}): DesignPage {
  const format = options?.format ?? DEFAULT_DESIGN_CANVAS_FORMAT
  const size = canvasSizeForFormat(format, options?.customSize)
  return {
    id: generateDesignPageId(),
    name: options?.name ?? 'Page 1',
    width: size.width,
    height: size.height,
    elements: [],
    background: 'FFFFFF'
  }
}

/**
 * 创建一个默认文档。
 */
export function createDesignDocument(options?: {
  name?: string
  format?: DesignCanvasFormat
  customSize?: { width: number; height: number }
}): DesignDocumentV1 {
  const now = Date.now()
  const format = options?.format ?? DEFAULT_DESIGN_CANVAS_FORMAT
  return {
    schemaVersion: 'v1',
    id: generateDesignDocumentId(),
    revision: 0,
    name: options?.name ?? '未命名设计',
    format,
    pages: [createDesignPage({ format, customSize: options?.customSize })],
    assets: [],
    appliedCommands: [],
    createdAt: now,
    updatedAt: now
  }
}

// ---------------------------------------------------------------------------
// 归一化（从 JSON 反序列化时的防御性处理）
// ---------------------------------------------------------------------------

/**
 * 校验颜色字符串是否合法（6 位 hex 无 #）。
 */
export function isValidDesignColor(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Fa-f]{6}$/.test(value)
}

function jsonStringUtf8Bytes(value: string): number {
  let bytes = 2 // surrounding quotes
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5c) {
      bytes += 2
    } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2
    } else if (code <= 0x1f) {
      bytes += 6
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 6
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6
    } else if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else {
      bytes += 3
    }
  }
  return bytes
}

function exceedsStringLimit(value: unknown, maxChars: number): boolean {
  return typeof value === 'string' && value.length > maxChars
}

/**
 * 在任何归一化或 JSON.stringify 之前检查原始 IPC/磁盘对象。
 * 除字段级限制外，还遍历未知字段，阻止利用深层/宽对象绕过 schema。
 */
export function validateDesignDocumentResourceLimits(input: unknown): DesignDocumentLimitResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Design document must be a JSON object.' }
  }

  const seen = new WeakSet<object>()
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  let containers = 0
  let estimatedBytes = 2
  // The traversal estimate intentionally over-counts numbers and punctuation.
  // Use it only as an early-abort guard; the exact compact JSON byte count below
  // remains the authoritative 8 MiB decision.
  const earlyAbortBytes = DESIGN_DOCUMENT_LIMITS.fileBytes * 2

  while (stack.length > 0) {
    const current = stack.pop()!
    const value = current.value
    if (value === null || value === undefined) {
      estimatedBytes += 4
      continue
    }
    if (typeof value === 'string') {
      if (value.length > DESIGN_DOCUMENT_LIMITS.genericStringChars) {
        return { ok: false, message: 'Design document contains a string that exceeds 256 Ki characters.' }
      }
      estimatedBytes += jsonStringUtf8Bytes(value)
      if (estimatedBytes > earlyAbortBytes) {
        return { ok: false, message: 'Design document exceeds the 8 MiB serialized limit.' }
      }
      continue
    }
    if (typeof value === 'number') {
      estimatedBytes += 32
      continue
    }
    if (typeof value === 'boolean') {
      estimatedBytes += 5
      continue
    }
    if (typeof value !== 'object') {
      return { ok: false, message: 'Design document contains a non-JSON value.' }
    }
    if (current.depth > DESIGN_DOCUMENT_LIMITS.nestingDepth) {
      return { ok: false, message: `Design document nesting exceeds ${DESIGN_DOCUMENT_LIMITS.nestingDepth}.` }
    }
    if (seen.has(value)) {
      return { ok: false, message: 'Design document contains a cyclic reference.' }
    }
    seen.add(value)
    containers += 1
    if (containers > DESIGN_DOCUMENT_LIMITS.genericContainers) {
      return { ok: false, message: 'Design document contains too many nested containers.' }
    }

    if (Array.isArray(value)) {
      if (value.length > DESIGN_DOCUMENT_LIMITS.genericArrayItems) {
        return { ok: false, message: 'Design document contains an oversized array.' }
      }
      estimatedBytes += value.length + 2
      for (const item of value) stack.push({ value: item, depth: current.depth + 1 })
    } else {
      const keys = Object.keys(value)
      if (keys.length > DESIGN_DOCUMENT_LIMITS.genericObjectKeys) {
        return { ok: false, message: 'Design document contains an object with too many fields.' }
      }
      estimatedBytes += keys.length + 2
      for (const key of keys) {
        estimatedBytes += jsonStringUtf8Bytes(key) + 1
        stack.push({
          value: (value as Record<string, unknown>)[key],
          depth: current.depth + 1
        })
      }
    }

    if (estimatedBytes > earlyAbortBytes) {
      return { ok: false, message: 'Design document exceeds the 8 MiB serialized limit.' }
    }
  }

  const raw = input as Record<string, unknown>
  if (
    exceedsStringLimit(raw.id, DESIGN_DOCUMENT_LIMITS.idChars) ||
    exceedsStringLimit(raw.name, DESIGN_DOCUMENT_LIMITS.nameChars)
  ) {
    return { ok: false, message: 'Design document id or name exceeds its limit.' }
  }
  if (Array.isArray(raw.pages)) {
    if (raw.pages.length > DESIGN_DOCUMENT_LIMITS.pages) {
      return { ok: false, message: `Design document exceeds ${DESIGN_DOCUMENT_LIMITS.pages} pages.` }
    }
    let totalElements = 0
    for (const pageValue of raw.pages) {
      if (!pageValue || typeof pageValue !== 'object' || Array.isArray(pageValue)) continue
      const page = pageValue as Record<string, unknown>
      if (
        exceedsStringLimit(page.id, DESIGN_DOCUMENT_LIMITS.idChars) ||
        exceedsStringLimit(page.name, DESIGN_DOCUMENT_LIMITS.nameChars)
      ) {
        return { ok: false, message: 'Design page id or name exceeds its limit.' }
      }
      if (!Array.isArray(page.elements)) continue
      if (page.elements.length > DESIGN_DOCUMENT_LIMITS.elementsPerPage) {
        return {
          ok: false,
          message: `A Design page exceeds ${DESIGN_DOCUMENT_LIMITS.elementsPerPage} elements.`
        }
      }
      totalElements += page.elements.length
      if (totalElements > DESIGN_DOCUMENT_LIMITS.elementsTotal) {
        return {
          ok: false,
          message: `Design document exceeds ${DESIGN_DOCUMENT_LIMITS.elementsTotal} elements.`
        }
      }
      for (const elementValue of page.elements) {
        if (!elementValue || typeof elementValue !== 'object' || Array.isArray(elementValue)) continue
        const element = elementValue as Record<string, unknown>
        if (
          exceedsStringLimit(element.id, DESIGN_DOCUMENT_LIMITS.idChars) ||
          exceedsStringLimit(element.name, DESIGN_DOCUMENT_LIMITS.nameChars) ||
          exceedsStringLimit(element.text, DESIGN_DOCUMENT_LIMITS.textChars) ||
          exceedsStringLimit(element.pathData, DESIGN_DOCUMENT_LIMITS.pathDataChars) ||
          exceedsStringLimit(element.fontFamily, DESIGN_DOCUMENT_LIMITS.fontFamilyChars) ||
          exceedsStringLimit(element.fontWeight, DESIGN_DOCUMENT_LIMITS.fontWeightChars) ||
          exceedsStringLimit(element.presetName, DESIGN_DOCUMENT_LIMITS.presetNameChars) ||
          exceedsStringLimit(element.imageAssetId, DESIGN_DOCUMENT_LIMITS.idChars)
        ) {
          return { ok: false, message: 'Design element contains an oversized string field.' }
        }
        if (
          Array.isArray(element.presetPaths) &&
          element.presetPaths.length > DESIGN_DOCUMENT_LIMITS.presetPathsPerElement
        ) {
          return { ok: false, message: 'Design element contains too many preset paths.' }
        }
        if (Array.isArray(element.presetPaths)) {
          for (const pathValue of element.presetPaths) {
            if (
              pathValue &&
              typeof pathValue === 'object' &&
              exceedsStringLimit(
                (pathValue as Record<string, unknown>).d,
                DESIGN_DOCUMENT_LIMITS.pathDataChars
              )
            ) {
              return { ok: false, message: 'Design preset path exceeds its string limit.' }
            }
          }
        }
        if (
          Array.isArray(element.childIds) &&
          element.childIds.length > DESIGN_DOCUMENT_LIMITS.childIdsPerGroup
        ) {
          return { ok: false, message: 'Design group contains too many child references.' }
        }
      }
    }
  }
  if (Array.isArray(raw.assets) && raw.assets.length > DESIGN_DOCUMENT_LIMITS.assets) {
    return { ok: false, message: `Design document exceeds ${DESIGN_DOCUMENT_LIMITS.assets} assets.` }
  }
  if (Array.isArray(raw.assets)) {
    for (const assetValue of raw.assets) {
      if (!assetValue || typeof assetValue !== 'object' || Array.isArray(assetValue)) continue
      const asset = assetValue as Record<string, unknown>
      if (
        exceedsStringLimit(asset.id, 128) ||
        exceedsStringLimit(asset.filename, 255) ||
        exceedsStringLimit(asset.mimeType, 64)
      ) {
        return { ok: false, message: 'Design asset contains an oversized string field.' }
      }
    }
  }
  if (raw.designTokens && typeof raw.designTokens === 'object' && !Array.isArray(raw.designTokens)) {
    const tokens = raw.designTokens as Record<string, unknown>
    for (const value of [tokens.colors, tokens.fonts, tokens.spacing]) {
      if (Array.isArray(value) && value.length > DESIGN_DOCUMENT_LIMITS.tokenValues) {
        return { ok: false, message: 'Design tokens contain too many values.' }
      }
    }
  }

  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    return { ok: false, message: 'Design document cannot be serialized safely.' }
  }
  const serializedBytes = new TextEncoder().encode(serialized).byteLength
  if (serializedBytes > DESIGN_DOCUMENT_LIMITS.fileBytes) {
    return { ok: false, message: 'Design document exceeds the 8 MiB serialized limit.' }
  }
  return { ok: true, serializedBytes }
}

/**
 * 归一化一个元素（从存盘 JSON 读取时，补全/修正字段）。
 * 用于防御损坏或部分缺失的数据。
 */
export function normalizeDesignElement(input: Partial<DesignElement> | null | undefined): DesignElement | null {
  if (!input || typeof input !== 'object') return null
  if (
    !input.id ||
    typeof input.id !== 'string' ||
    input.id.length > DESIGN_DOCUMENT_LIMITS.idChars ||
    exceedsStringLimit(input.name, DESIGN_DOCUMENT_LIMITS.nameChars) ||
    exceedsStringLimit(input.text, DESIGN_DOCUMENT_LIMITS.textChars) ||
    exceedsStringLimit(input.pathData, DESIGN_DOCUMENT_LIMITS.pathDataChars) ||
    exceedsStringLimit(input.fontFamily, DESIGN_DOCUMENT_LIMITS.fontFamilyChars) ||
    exceedsStringLimit(input.fontWeight, DESIGN_DOCUMENT_LIMITS.fontWeightChars) ||
    exceedsStringLimit(input.presetName, DESIGN_DOCUMENT_LIMITS.presetNameChars) ||
    exceedsStringLimit(input.imageAssetId, DESIGN_DOCUMENT_LIMITS.idChars) ||
    (Array.isArray(input.presetPaths) &&
      input.presetPaths.length > DESIGN_DOCUMENT_LIMITS.presetPathsPerElement) ||
    (Array.isArray(input.childIds) &&
      input.childIds.length > DESIGN_DOCUMENT_LIMITS.childIdsPerGroup)
  ) return null
  if (!input.type || !DESIGN_ELEMENT_TYPES.includes(input.type as DesignElementType)) return null

  const isLine = input.type === 'line'
  const element: DesignElement = {
    id: input.id,
    type: input.type as DesignElementType,
    x: typeof input.x === 'number' && Number.isFinite(input.x) ? input.x : 0,
    y: typeof input.y === 'number' && Number.isFinite(input.y) ? input.y : 0,
    // 线条用带符号的 w/h 表达方向（向左/向上的线为负值），归一化时必须保留；
    // 其他元素仍要求正尺寸，缺失或非法时回退默认值。
    w: typeof input.w === 'number' && Number.isFinite(input.w) && (isLine ? input.w !== 0 : input.w > 0)
      ? input.w
      : 100,
    h: typeof input.h === 'number' && Number.isFinite(input.h) && (isLine ? input.h !== 0 : input.h > 0)
      ? input.h
      : 100,
    rotation: typeof input.rotation === 'number' && Number.isFinite(input.rotation) ? input.rotation : 0,
    zIndex: typeof input.zIndex === 'number' && Number.isFinite(input.zIndex) ? input.zIndex : 0,
    ...(input.fill !== undefined ? { fill: isValidDesignColor(input.fill) ? input.fill : '000000' } : {}),
    ...(input.stroke !== undefined ? { stroke: isValidDesignColor(input.stroke) ? input.stroke : '000000' } : {}),
    ...(typeof input.strokeWidth === 'number' ? { strokeWidth: input.strokeWidth } : {}),
    ...(input.strokeLinecap === 'butt' ||
      input.strokeLinecap === 'round' ||
      input.strokeLinecap === 'square'
      ? { strokeLinecap: input.strokeLinecap }
      : {}),
    ...(input.strokeLinejoin === 'miter' ||
      input.strokeLinejoin === 'round' ||
      input.strokeLinejoin === 'bevel'
      ? { strokeLinejoin: input.strokeLinejoin }
      : {}),
    ...(typeof input.opacity === 'number' && input.opacity >= 0 && input.opacity <= 1 ? { opacity: input.opacity } : {}),
    ...(typeof input.text === 'string' ? { text: input.text } : {}),
    ...(typeof input.fontSize === 'number' && input.fontSize > 0 ? { fontSize: input.fontSize } : {}),
    ...(typeof input.fontFamily === 'string' ? { fontFamily: input.fontFamily } : {}),
    ...(typeof input.fontWeight === 'string' ? { fontWeight: input.fontWeight } : {}),
    ...(input.textAlign !== undefined ? { textAlign: input.textAlign } : {}),
    ...(typeof input.imageAssetId === 'string' ? { imageAssetId: input.imageAssetId } : {}),
    ...(typeof input.presetName === 'string' ? { presetName: input.presetName } : {}),
    ...(typeof input.pathData === 'string' ? { pathData: input.pathData } : {}),
    ...(Array.isArray(input.presetPaths)
      ? {
          presetPaths: input.presetPaths.flatMap((rawPath) => {
            if (!rawPath || typeof rawPath !== 'object' || typeof rawPath.d !== 'string') return []
            const path: DesignPresetPath = { d: rawPath.d }
            if (rawPath.fill === null || isValidDesignColor(rawPath.fill)) path.fill = rawPath.fill
            if (rawPath.stroke === null || isValidDesignColor(rawPath.stroke)) path.stroke = rawPath.stroke
            if (
              typeof rawPath.strokeWidth === 'number' &&
              Number.isFinite(rawPath.strokeWidth) &&
              rawPath.strokeWidth >= 0
            ) {
              path.strokeWidth = rawPath.strokeWidth
            }
            if (
              typeof rawPath.opacity === 'number' &&
              Number.isFinite(rawPath.opacity) &&
              rawPath.opacity >= 0 &&
              rawPath.opacity <= 1
            ) {
              path.opacity = rawPath.opacity
            }
            return [path]
          })
        }
      : {}),
    ...(Array.isArray(input.childIds) ? { childIds: input.childIds.filter((id): id is string => typeof id === 'string') } : {}),
    ...(typeof input.name === 'string' ? { name: input.name } : {}),
    ...(input.locked === true ? { locked: true } : {}),
    ...(input.hidden === true ? { hidden: true } : {})
  }
  return element
}

/**
 * 归一化文档（从存盘 JSON 读取时的防御性处理）。
 * 跳过损坏的页面/元素，保证返回值始终合法可用。
 */
export function normalizeDesignDocument(input: Partial<DesignDocumentV1> | null | undefined): DesignDocumentV1 | null {
  if (!input || typeof input !== 'object') return null
  if (!validateDesignDocumentResourceLimits(input).ok) return null

  const pages: DesignPage[] = []
  if (Array.isArray(input.pages)) {
    for (const rawPage of input.pages) {
      if (!rawPage || typeof rawPage !== 'object') continue
      const page = rawPage as Partial<DesignPage>
      if (!page.id || typeof page.id !== 'string') continue
      const elements: DesignElement[] = []
      if (Array.isArray(page.elements)) {
        for (const rawElement of page.elements) {
          const element = normalizeDesignElement(rawElement)
          if (element) elements.push(element)
        }
      }
      pages.push({
        id: page.id,
        name: typeof page.name === 'string' && page.name.trim() ? page.name.trim() : 'Page',
        width: typeof page.width === 'number' && Number.isFinite(page.width) && page.width > 0 ? Math.round(page.width) : 1280,
        height: typeof page.height === 'number' && Number.isFinite(page.height) && page.height > 0 ? Math.round(page.height) : 720,
        elements,
        ...(page.background !== undefined && isValidDesignColor(page.background) ? { background: page.background } : {}),
        ...(typeof page.fidelityImageAssetId === 'string' && page.fidelityImageAssetId.trim()
          ? { fidelityImageAssetId: page.fidelityImageAssetId.trim() }
          : {}),
        ...(page.displayMode === 'fidelity' || page.displayMode === 'editable'
          ? { displayMode: page.displayMode }
          : {})
      })
    }
  }

  // 没有 page 或损坏的文档，返回 null（调用方新建空文档）
  if (pages.length === 0) return null

  const now = Date.now()
  const designTokens = normalizeDesignTokens(input.designTokens)
  const appliedCommands = normalizeAppliedCommands(input.appliedCommands)
  if (appliedCommands === null) return null
  const normalized: DesignDocumentV1 = {
    schemaVersion: 'v1',
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : generateDesignDocumentId(),
    revision:
      typeof input.revision === 'number' &&
      Number.isSafeInteger(input.revision) &&
      input.revision >= 0
        ? input.revision
        : 0,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '未命名设计',
    format: input.format && DESIGN_CANVAS_FORMATS.includes(input.format as DesignCanvasFormat)
      ? (input.format as DesignCanvasFormat)
      : DEFAULT_DESIGN_CANVAS_FORMAT,
    pages,
    assets: normalizeDesignAssets(input.assets),
    appliedCommands,
    ...(designTokens ? { designTokens } : {}),
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now
  }
  return validateDesignDocumentStructure(normalized) ? normalized : null
}

const SAFE_COMMAND_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,160}$/

function normalizeAppliedCommands(input: unknown): DesignAppliedCommandRecord[] | null {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 200) return null
  const seen = new Set<string>()
  const records: DesignAppliedCommandRecord[] = []
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const raw = candidate as Partial<DesignAppliedCommandRecord>
    if (
      typeof raw.idempotencyKey !== 'string' ||
      !SAFE_COMMAND_IDEMPOTENCY_KEY.test(raw.idempotencyKey) ||
      seen.has(raw.idempotencyKey) ||
      !Number.isSafeInteger(raw.revision) ||
      (raw.revision ?? -1) < 0 ||
      !Number.isSafeInteger(raw.appliedOperations) ||
      (raw.appliedOperations ?? -1) < 0 ||
      (raw.appliedOperations ?? 65) > 64
    ) {
      return null
    }
    seen.add(raw.idempotencyKey)
    records.push({
      idempotencyKey: raw.idempotencyKey,
      revision: raw.revision!,
      appliedOperations: raw.appliedOperations!
    })
  }
  return records
}

const SAFE_ASSET_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const DESIGN_ASSET_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function normalizeDesignAssets(input: unknown): DesignAsset[] {
  if (!Array.isArray(input)) return []
  const seenIds = new Set<string>()
  const seenFiles = new Set<string>()
  const assets: DesignAsset[] = []
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') continue
    const raw = candidate as Partial<DesignAsset>
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const filename = typeof raw.filename === 'string' ? raw.filename.trim() : ''
    const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType.trim().toLowerCase() : ''
    if (
      !id ||
      id.length > 128 ||
      !SAFE_ASSET_FILENAME.test(filename) ||
      !DESIGN_ASSET_MIME_TYPES.has(mimeType) ||
      seenIds.has(id) ||
      seenFiles.has(filename.toLowerCase())
    ) {
      continue
    }
    const width =
      typeof raw.width === 'number' && Number.isSafeInteger(raw.width) && raw.width > 0
        ? raw.width
        : 1
    const height =
      typeof raw.height === 'number' && Number.isSafeInteger(raw.height) && raw.height > 0
        ? raw.height
        : 1
    const byteSize =
      typeof raw.byteSize === 'number' && Number.isSafeInteger(raw.byteSize) && raw.byteSize >= 0
        ? raw.byteSize
        : 0
    seenIds.add(id)
    seenFiles.add(filename.toLowerCase())
    assets.push({ id, filename, mimeType, width, height, byteSize })
  }
  return assets
}

function normalizeDesignTokens(input: unknown): DesignDocumentV1['designTokens'] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as NonNullable<DesignDocumentV1['designTokens']>
  const colors = Array.isArray(raw.colors)
    ? raw.colors
      .filter(isValidDesignColor)
      .slice(0, DESIGN_DOCUMENT_LIMITS.tokenValues)
    : undefined
  const fonts = Array.isArray(raw.fonts)
    ? raw.fonts
      .filter((font): font is string =>
        typeof font === 'string' && font.length <= DESIGN_DOCUMENT_LIMITS.fontFamilyChars
      )
      .slice(0, DESIGN_DOCUMENT_LIMITS.tokenValues)
    : undefined
  const spacing = Array.isArray(raw.spacing)
    ? raw.spacing
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .slice(0, DESIGN_DOCUMENT_LIMITS.tokenValues)
    : undefined
  if (!colors && !fonts && !spacing) return null
  return {
    ...(colors ? { colors } : {}),
    ...(fonts ? { fonts } : {}),
    ...(spacing ? { spacing } : {})
  }
}

/**
 * 校验文档的引用结构。归一化只修复缺省字段；重复 id、孤立资源引用和
 * group 循环属于数据损坏，必须拒绝而不能静默丢内容。
 */
export function validateDesignDocumentStructure(document: DesignDocumentV1): boolean {
  if (!validateDesignDocumentResourceLimits(document).ok) return false
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) return false
  if (
    !Array.isArray(document.appliedCommands) ||
    document.appliedCommands.length > 200 ||
    document.appliedCommands.some((record) =>
      !SAFE_COMMAND_IDEMPOTENCY_KEY.test(record.idempotencyKey) ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0 ||
      record.revision > document.revision ||
      !Number.isSafeInteger(record.appliedOperations) ||
      record.appliedOperations < 0 ||
      record.appliedOperations > 64
    ) ||
    new Set(document.appliedCommands.map((record) => record.idempotencyKey)).size !==
      document.appliedCommands.length
  ) {
    return false
  }
  const pageIds = new Set<string>()
  const assetIds = new Set(document.assets.map((asset) => asset.id))

  for (const page of document.pages) {
    if (!page.id || pageIds.has(page.id)) return false
    pageIds.add(page.id)
    const elementById = new Map<string, DesignElement>()
    for (const element of page.elements) {
      if (!element.id || elementById.has(element.id)) return false
      elementById.set(element.id, element)
      if (element.type === 'image' && (!element.imageAssetId || !assetIds.has(element.imageAssetId))) {
        return false
      }
    }

    const parentByChild = new Map<string, string>()
    for (const element of page.elements) {
      if (element.type !== 'group') continue
      const uniqueChildren = new Set(element.childIds ?? [])
      if (uniqueChildren.size !== (element.childIds?.length ?? 0)) return false
      for (const childId of uniqueChildren) {
        if (childId === element.id || !elementById.has(childId) || parentByChild.has(childId)) return false
        parentByChild.set(childId, element.id)
      }
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): boolean => {
      if (visited.has(id)) return true
      if (visiting.has(id)) return false
      visiting.add(id)
      const element = elementById.get(id)
      for (const childId of element?.type === 'group' ? element.childIds ?? [] : []) {
        if (!visit(childId)) return false
      }
      visiting.delete(id)
      visited.add(id)
      return true
    }
    for (const element of page.elements) {
      if (!visit(element.id)) return false
    }
  }
  return true
}

export function designGroupBounds(
  elements: ReadonlyArray<DesignElement>,
  childIds: ReadonlyArray<string>
): { x: number; y: number; w: number; h: number } | null {
  const byId = new Map(elements.map((element) => [element.id, element]))
  const descendants = collectDesignDescendantIds(elements, childIds)
    .map((id) => byId.get(id))
    .filter((element): element is DesignElement => Boolean(element && element.type !== 'group'))
  if (descendants.length === 0) return null
  const left = Math.min(...descendants.map((element) => element.x))
  const top = Math.min(...descendants.map((element) => element.y))
  const right = Math.max(...descendants.map((element) => element.x + element.w))
  const bottom = Math.max(...descendants.map((element) => element.y + element.h))
  return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) }
}

export function collectDesignDescendantIds(
  elements: ReadonlyArray<DesignElement>,
  roots: ReadonlyArray<string>
): string[] {
  const byId = new Map(elements.map((element) => [element.id, element]))
  const collected: string[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    const element = byId.get(id)
    if (!element) return
    collected.push(id)
    if (element.type === 'group') {
      for (const childId of element.childIds ?? []) visit(childId)
    }
  }
  for (const root of roots) visit(root)
  return collected
}

/** 深复制页面并重写 group childIds，避免副本继续引用源页元素。 */
export function duplicateDesignPage(sourcePage: DesignPage): DesignPage {
  const idMap = new Map(sourcePage.elements.map((element) => [element.id, generateDesignElementId()]))
  const elements = sourcePage.elements.map((element) => ({
    ...structuredClone(element),
    id: idMap.get(element.id)!,
    ...(element.type === 'group'
      ? { childIds: (element.childIds ?? []).map((id) => idMap.get(id)).filter((id): id is string => Boolean(id)) }
      : {})
  }))
  return {
    ...structuredClone(sourcePage),
    id: generateDesignPageId(),
    name: `${sourcePage.name} copy`,
    elements
  }
}
