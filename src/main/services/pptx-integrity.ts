import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { DOMParser, XMLSerializer, type Element, type Node } from '@xmldom/xmldom'
import JSZip from 'jszip'
import type { PptxImportReport, PptxSourceObject } from '../../shared/pptx-document'

const MAX_BYTES = 200 * 1024 * 1024
const MAX_XML_BYTES = 64 * 1024 * 1024
const MAX_INFLATED_BYTES = 512 * 1024 * 1024
const OBJECT_TAGS = new Set(['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp', 'contentPart', 'AlternateContent'])
const PROTECTED_PARTS = /^ppt\/(?:diagrams|activeX|slideMasters|slideLayouts|theme)\/|^ppt\/vbaProject\./

type Relationship = { id: string; type: string; target: string; external: boolean }
type XmlDocument = ReturnType<DOMParser['parseFromString']>
export type PptxPackageInspection = {
  report: PptxImportReport
  slideParts: string[]
  /** Object XML and unsupported package parts are fingerprinted, never flattened. */
  protectedFingerprints: Record<string, string>
  slideText: string[]
  mediaDigests: Record<string, string>
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function children(node: Node): Element[] {
  return Array.from(node.childNodes).filter((item): item is Element => item.nodeType === 1)
}

function descendants(node: Node, localName?: string): Element[] {
  const result: Element[] = []
  const pending = children(node).reverse()
  while (pending.length) {
    const current = pending.pop()!
    if (!localName || current.localName === localName) result.push(current)
    pending.push(...children(current).reverse())
  }
  return result
}

function parseXml(xml: string, path: string): XmlDocument {
  if (Buffer.byteLength(xml) > MAX_XML_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error(`Unsafe or oversized XML part: ${path}.`)
  }
  const document = new DOMParser({ onError: (level, message) => {
    if (level !== 'warning') throw new Error(`${path}: ${message}`)
  } }).parseFromString(xml, 'application/xml')
  if (!document.documentElement) throw new Error(`Empty XML part: ${path}.`)
  return document
}

/** Namespace-prefix and attribute-order independent fingerprint. */
function canonical(node: Node): string {
  if (node.nodeType === 3 || node.nodeType === 4) return JSON.stringify(node.nodeValue)
  if (node.nodeType !== 1) return ''
  const element = node as Element
  const attrs = Array.from(element.attributes)
    .filter((attribute) => attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && attribute.name !== 'xmlns')
    .map((attribute) => [`${attribute.namespaceURI ?? ''}:${attribute.localName}`, attribute.value])
    .sort((a, b) => a[0].localeCompare(b[0]))
  const content = Array.from(element.childNodes).filter((item) =>
    item.nodeType !== 3 || Boolean(item.nodeValue?.trim())
  ).map(canonical)
  return JSON.stringify([element.namespaceURI ?? '', element.localName, attrs, content])
}

function targetPart(owner: string, target: string): string {
  if (!target || target.includes('\\') || target.includes('\0') || /^[a-z]+:/i.test(target)) {
    throw new Error(`Unsafe OOXML relationship target: ${target}.`)
  }
  const path = target.startsWith('/')
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join(posix.dirname(owner), target))
  if (path.startsWith('../') || path === '..') throw new Error('OOXML relationship escapes its package.')
  return path
}

function relations(document: XmlDocument): Relationship[] {
  return descendants(document, 'Relationship').map((element) => ({
    id: element.getAttribute('Id') ?? '',
    type: element.getAttribute('Type') ?? '',
    target: element.getAttribute('Target') ?? '',
    external: element.getAttribute('TargetMode') === 'External'
  }))
}

function relationshipPath(owner: string): string {
  return `${posix.dirname(owner)}/_rels/${posix.basename(owner)}.rels`
}

function objectType(element: Element): { type: string; reason?: string } {
  if (element.localName === 'grpSp') return { type: 'group' }
  if (descendants(element).some((item) => ['videoFile', 'audioFile', 'wavAudioFile', 'model3d', 'scene3d', 'sp3d'].includes(item.localName ?? ''))) {
    return { type: 'advanced-media', reason: 'Media and 3D effects retain their original OOXML and cannot be directly edited.' }
  }
  if (descendants(element, 'fld').length) return { type: 'dynamic-field', reason: 'Office dynamic fields retain their original OOXML and cached display text.' }
  if (element.localName === 'pic') return { type: 'image' }
  if (element.localName === 'cxnSp') return { type: 'connector' }
  if (element.localName === 'AlternateContent') return { type: 'alternate-content', reason: 'AlternateContent requires original OOXML preservation.' }
  if (element.localName === 'contentPart') return { type: 'content-part', reason: 'External content part is not directly editable.' }
  if (descendants(element, 'oleObj').length) return { type: 'embedded-object', reason: 'Embedded Office objects are protected.' }
  if (descendants(element, 'relIds').length) return { type: 'smart-art', reason: 'SmartArt must retain its original diagram data and drawing.' }
  if (descendants(element, 'tbl').length) return { type: 'table' }
  if (descendants(element, 'chart').length) return { type: 'chart' }
  if (element.localName === 'graphicFrame') return { type: 'graphic-frame', reason: 'Unknown graphic frame payload is protected.' }
  if (descendants(element, 't').length) return { type: 'text' }
  return { type: 'shape' }
}

export async function inspectPptxPackage(input: Uint8Array): Promise<PptxPackageInspection> {
  const bytes = Buffer.from(input)
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('PPTX exceeds the 200 MiB size limit.')
  // Read the central-directory sizes before inflating/CRC-checking any entry.
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false })
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  if (names.length > 20_000) throw new Error('PPTX contains too many parts.')
  let inflatedBytes = 0
  for (const file of Object.values(zip.files)) {
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    inflatedBytes += size
    if (size > MAX_INFLATED_BYTES || inflatedBytes > MAX_INFLATED_BYTES) throw new Error('PPTX exceeds the expanded size limit.')
  }
  const readXml = async (path: string): Promise<XmlDocument> => {
    const file = zip.file(path)
    if (!file) throw new Error(`Missing OOXML part: ${path}.`)
    return parseXml(await file.async('string'), path)
  }
  const presentation = await readXml('ppt/presentation.xml')
  const presentationRelationships = relations(await readXml('ppt/_rels/presentation.xml.rels'))
  const slideIds = descendants(presentation, 'sldId')
  const slideParts = slideIds.map((slide) => {
    const id = slide.getAttribute('r:id') ?? Array.from(slide.attributes).find((a) => a.localName === 'id' && a.prefix)?.value
    const relationship = presentationRelationships.find((item) => item.id === id)
    if (!relationship || relationship.external || !relationship.type.endsWith('/slide')) throw new Error('Invalid slide relationship in presentation.')
    return targetPart('ppt/presentation.xml', relationship.target)
  })
  if (!slideParts.length || slideParts.length > 500 || new Set(slideParts).size !== slideParts.length) {
    throw new Error('PPTX contains no slides, duplicate slides, or more than 500 slides.')
  }
  const size = descendants(presentation, 'sldSz')[0]
  const width = size ? Number(size.getAttribute('cx')) / 9525 : 1280
  const height = size ? Number(size.getAttribute('cy')) / 9525 : 720
  const report: PptxImportReport = {
    sourceSha256: hash(bytes), sourceBytes: bytes.length,
    sourceSlideCount: slideParts.length, importedSlideCount: slideParts.length,
    backend: 'pptx-vanilla-viewer', backendVersion: '3.61.0', status: 'complete',
    pages: [], objects: [], warnings: [], errors: [], generatedAt: Date.now()
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    report.errors.push('Invalid slide canvas geometry.')
  }
  const protectedFingerprints: Record<string, string> = {}
  const mediaDigests: Record<string, string> = {}
  for (const path of names.filter((name) => name.startsWith('ppt/media/'))) {
    mediaDigests[path] = hash(await zip.file(path)!.async('uint8array'))
  }
  // Parse every XML payload, not just the presentation shell: malformed chart,
  // table-style or notes XML must not be committed as a valid native export.
  for (const path of names.filter((name) => /\.xml$|\.rels$/i.test(name))) {
    const xml = await readXml(path)
    if (!path.endsWith('.rels')) continue
    const owner = path === '_rels/.rels' ? '' : path.replace(/(^|\/)_rels\//, '$1').slice(0, -'.rels'.length)
    const ids = new Set<string>()
    for (const relationship of relations(xml)) {
      if (!relationship.id || ids.has(relationship.id) || !relationship.target) {
        report.errors.push(`Malformed or duplicate relationship in ${path}.`)
      }
      ids.add(relationship.id)
      if (!relationship.external && !zip.file(targetPart(owner, relationship.target))) {
        report.errors.push(`Missing resource from ${path}: ${relationship.target}.`)
      }
    }
  }
  const slideText: string[] = []
  for (const [pageIndex, part] of slideParts.entries()) {
    const document = await readXml(part)
    const root = document.documentElement!
    const warnings: string[] = []
    const relPath = relationshipPath(part)
    const relationships = zip.file(relPath) ? relations(await readXml(relPath)) : []
    for (const relationship of relationships) {
      if (!relationship.external && !zip.file(targetPart(part, relationship.target))) {
        report.errors.push(`Slide ${pageIndex + 1}: missing resource ${relationship.target}.`)
      }
      if (relationship.external && /\/(image|audio|video|media)$/.test(relationship.type)) {
        warnings.push(`External media blocked: ${relationship.target}.`)
      }
    }
    slideText.push(descendants(root, 't').map((item) => item.textContent ?? '').join('\n'))
    const spTree = descendants(root, 'spTree')[0]
    const objects = spTree ? descendants(spTree).filter((element) => {
      if (!OBJECT_TAGS.has(element.localName ?? '')) return false
      let parent = element.parentNode
      while (parent && parent !== spTree) {
        if (parent.nodeType === 1 && (parent as Element).localName === 'AlternateContent') return false
        parent = parent.parentNode
      }
      return true
    }) : []
    const ids = new Set<string>()
    const pageObjects: PptxSourceObject[] = []
    for (const [objectIndex, element] of objects.entries()) {
      const nv = descendants(element, 'cNvPr')[0]
      const sourceId = nv?.getAttribute('id') || `anonymous-${objectIndex}`
      if (ids.has(sourceId)) report.errors.push(`Slide ${pageIndex + 1}: duplicate object ID ${sourceId}.`)
      ids.add(sourceId)
      const type = objectType(element)
      const object: PptxSourceObject = {
        id: sourceId, pageIndex, sourcePart: part, name: nv?.getAttribute('name') ?? undefined,
        type: type.type, support: type.reason ? 'protected' : 'editable',
        ...(type.reason ? { reason: type.reason } : {}),
        text: descendants(element, 't').map((item) => item.textContent ?? '').join('\n'),
        fonts: [...new Set(descendants(element).filter((item) => ['latin', 'ea', 'cs'].includes(item.localName ?? '')).map((item) => item.getAttribute('typeface') || '').filter(Boolean))],
        textRunCount: descendants(element, 'r').length,
        ...(type.type === 'table' ? { table: {
          rows: descendants(element, 'tr').length,
          columns: descendants(element, 'gridCol').length,
          mergedCells: descendants(element, 'tc').filter((cell) => ['gridSpan', 'rowSpan', 'hMerge', 'vMerge'].some((attr) => cell.hasAttribute(attr))).length
        } } : {})
      }
      const xfrm = descendants(element, 'xfrm')[0]
      if (xfrm) {
        const off = children(xfrm).find((item) => item.localName === 'off')
        const ext = children(xfrm).find((item) => item.localName === 'ext')
        if (off && ext) {
          object.geometry = { x: Number(off.getAttribute('x')) / 9525, y: Number(off.getAttribute('y')) / 9525,
            width: Number(ext.getAttribute('cx')) / 9525, height: Number(ext.getAttribute('cy')) / 9525,
            rotation: Number(xfrm.getAttribute('rot') || 0) / 60000 }
          if (Object.values(object.geometry).some((number) => !Number.isFinite(number))) {
            object.support = 'failed'; object.reason = 'Invalid object geometry.'
            report.errors.push(`Slide ${pageIndex + 1}, object ${sourceId}: invalid geometry.`)
          } else if (object.geometry.x > width || object.geometry.y > height || object.geometry.x + object.geometry.width < 0 || object.geometry.y + object.geometry.height < 0) {
            warnings.push(`Object ${sourceId} is outside the canvas (group-local coordinates may differ).`)
          }
        }
      }
      if (type.reason) protectedFingerprints[`object:${part}#${sourceId}`] = hash(canonical(element))
      for (const node of [element, ...descendants(element)]) {
        for (const attribute of Array.from(node.attributes)) {
          if (attribute.namespaceURI?.endsWith('/relationships') || attribute.prefix === 'r') {
            const relationship = relationships.find((item) => item.id === attribute.value)
            if (!relationship) {
              report.errors.push(`Slide ${pageIndex + 1}, object ${sourceId}: missing relationship ${attribute.value}.`)
            } else if (type.reason && !relationship.external) {
              const path = targetPart(part, relationship.target)
              const content = await zip.file(path)?.async('uint8array')
              if (content) protectedFingerprints[`part:${path}`] = /\.xml$/i.test(path)
                ? hash(canonical(parseXml(Buffer.from(content).toString('utf8'), path).documentElement!)) : hash(content)
            }
          }
        }
      }
      pageObjects.push(object)
      if (report.objects.length + pageObjects.length > 30_000) throw new Error('PPTX exceeds the 30,000 object limit.')
    }
    for (const tag of ['timing', 'transition', 'clrMapOvr']) {
      const features = descendants(root, tag).filter((element) => {
        // MC fallback duplicates the effective transition for older Office.
        // A native serializer may keep the chosen transition directly; compare
        // the active branch rather than requiring redundant fallback markup.
        let parent = element.parentNode
        while (parent && parent !== root) {
          if (parent.nodeType === 1 && (parent as Element).localName === 'Fallback') return false
          parent = parent.parentNode
        }
        return true
      })
      for (const [index, element] of features.entries()) {
        protectedFingerprints[`slide-feature:${part}#${tag}-${index}`] = hash(canonical(element))
        if (tag === 'timing') warnings.push('Animations are protected and verified when saving/exporting.')
      }
    }
    report.objects.push(...pageObjects)
    report.pages.push({ pageIndex, sourceName: part, width, height, objectCount: pageObjects.length,
      editableObjectCount: pageObjects.filter((item) => item.support === 'editable').length,
      protectedObjectCount: pageObjects.filter((item) => item.support === 'protected').length,
      failedObjectCount: pageObjects.filter((item) => item.support === 'failed').length, warnings })
    report.warnings.push(...warnings.map((warning) => `Slide ${pageIndex + 1}: ${warning}`))
  }
  for (const path of names.filter((name) => PROTECTED_PARTS.test(name))) {
    const content = await zip.file(path)!.async('uint8array')
    protectedFingerprints[`part:${path}`] = /\.xml$|\.rels$/i.test(path)
      ? hash(canonical(parseXml(Buffer.from(content).toString('utf8'), path).documentElement!))
      : hash(content)
  }
  report.status = report.errors.length ? 'blocked'
    : report.warnings.length || report.objects.some((object) => object.support === 'protected') ? 'partial' : 'complete'
  return { report, slideParts, protectedFingerprints, slideText, mediaDigests }
}

/** Reparse actual exported bytes; protected payloads must survive unchanged. */
export async function validatePptxRoundTrip(sourceBytes: Uint8Array, candidateBytes: Uint8Array): Promise<PptxPackageInspection> {
  const [source, candidate] = await Promise.all([inspectPptxPackage(sourceBytes), inspectPptxPackage(candidateBytes)])
  if (candidate.report.errors.length) throw new Error(`PPTX semantic validation failed: ${candidate.report.errors.join(' ')}`)
  for (const [key, digest] of Object.entries(source.protectedFingerprints)) {
    if (candidate.protectedFingerprints[key] !== digest) {
      throw new Error(`PPTX protected content changed or disappeared: ${key}. The original and previous revision were preserved.`)
    }
  }
  return candidate
}

/**
 * The editor owns ordinary shapes; immutable source objects and supporting
 * parts remain owned by OOXML. Restore those parts before validating the
 * native output, because general-purpose serializers can clear cached fields
 * in masters or omit opaque SmartArt while editing an unrelated title.
 * A removed page/parent is rejected rather than silently re-created.
 */
export async function preserveProtectedPptxContent(sourceBytes: Uint8Array, candidateBytes: Uint8Array): Promise<Buffer> {
  const source = await inspectPptxPackage(sourceBytes)
  // Bound and parse candidate content before attempting any preservation work.
  await inspectPptxPackage(candidateBytes)
  const original = await JSZip.loadAsync(sourceBytes, { createFolders: false })
  const candidate = await JSZip.loadAsync(candidateBytes, { createFolders: false })
  let changed = false
  for (const key of Object.keys(source.protectedFingerprints).filter((key) => key.startsWith('part:'))) {
    const path = key.slice('part:'.length)
    const bytes = await original.file(path)!.async('uint8array')
    const existing = await candidate.file(path)?.async('uint8array')
    if (!existing || !Buffer.from(existing).equals(Buffer.from(bytes))) {
      candidate.file(path, bytes); changed = true
    }
  }
  const serializer = new XMLSerializer()
  const originalTypes = parseXml(await original.file('[Content_Types].xml')!.async('string'), '[Content_Types].xml')
  const candidateTypesFile = candidate.file('[Content_Types].xml')
  if (!candidateTypesFile) throw new Error('Native export is missing content types.')
  const candidateTypes = parseXml(await candidateTypesFile.async('string'), '[Content_Types].xml')
  const protectedPaths = new Set(Object.keys(source.protectedFingerprints).filter((key) => key.startsWith('part:')).map((key) => key.slice('part:'.length)))
  for (const definition of children(originalTypes.documentElement!)) {
    const partName = definition.getAttribute('PartName')
    const extension = definition.getAttribute('Extension')
    if (partName && !protectedPaths.has(partName.replace(/^\//, ''))) continue
    if (!partName && !extension) continue
    const current = children(candidateTypes.documentElement!).find((node) =>
      partName ? node.getAttribute('PartName') === partName : node.getAttribute('Extension') === extension)
    if (!current) { candidateTypes.documentElement!.appendChild(candidateTypes.importNode(definition, true)); changed = true }
    else if (partName && current.getAttribute('ContentType') !== definition.getAttribute('ContentType')) {
      throw new Error(`Protected OOXML content type changed: ${partName}.`)
    }
  }
  for (const part of source.slideParts) {
    const objects = source.report.objects.filter((object) => object.sourcePart === part && object.support === 'protected')
    if (!objects.length) continue
    const originalDoc = parseXml(await original.file(part)!.async('string'), part)
    const candidateFile = candidate.file(part)
    if (!candidateFile) throw new Error(`Protected slide ${part} was removed; explicit protected-page replacement is required.`)
    const candidateDoc = parseXml(await candidateFile.async('string'), part)
    const originalTree = descendants(originalDoc, 'spTree')[0]
    const candidateTree = descendants(candidateDoc, 'spTree')[0]
    if (!originalTree || !candidateTree) throw new Error(`Missing object tree in protected slide ${part}.`)
    const relPath = relationshipPath(part)
    const originalRels = original.file(relPath) ? parseXml(await original.file(relPath)!.async('string'), relPath) : undefined
    let candidateRels = candidate.file(relPath) ? parseXml(await candidate.file(relPath)!.async('string'), relPath) : undefined
    for (const object of objects) {
      const sourceNode = descendants(originalTree).find((node) => OBJECT_TAGS.has(node.localName ?? '') && descendants(node, 'cNvPr')[0]?.getAttribute('id') === object.id)
      if (!sourceNode) throw new Error(`Protected source object ${part}#${object.id} is unavailable.`)
      const existing = descendants(candidateTree).find((node) => OBJECT_TAGS.has(node.localName ?? '') && descendants(node, 'cNvPr')[0]?.getAttribute('id') === object.id)
      const originalParent = sourceNode.parentNode as Element
      let destinationParent: Element = candidateTree
      if (originalParent.localName === 'grpSp') {
        const parentId = descendants(originalParent, 'cNvPr')[0]?.getAttribute('id')
        const parent = descendants(candidateTree, 'grpSp').find((node) => descendants(node, 'cNvPr')[0]?.getAttribute('id') === parentId)
        if (!parent) throw new Error(`Protected object parent ${parentId} was removed.`)
        destinationParent = parent
      }
      if (existing && objectType(existing).type !== object.type) {
        throw new Error(`Protected object ${part}#${object.id} was replaced with another object type.`)
      }
      if (!existing || canonical(existing) !== canonical(sourceNode)) {
        const restored = candidateDoc.importNode(sourceNode, true)
        if (existing) existing.parentNode!.replaceChild(restored, existing)
        else {
          const nextSiblingIds = children(originalParent).slice(children(originalParent).indexOf(sourceNode) + 1)
            .map((node) => descendants(node, 'cNvPr')[0]?.getAttribute('id')).filter(Boolean)
          const next = children(destinationParent).find((node) => nextSiblingIds.includes(descendants(node, 'cNvPr')[0]?.getAttribute('id')))
          destinationParent.insertBefore(restored, next ?? null)
        }
        changed = true
      }
      for (const node of [sourceNode, ...descendants(sourceNode)]) {
        for (const attribute of Array.from(node.attributes).filter((attr) => attr.namespaceURI?.endsWith('/relationships') || attr.prefix === 'r')) {
          const sourceRel = originalRels && descendants(originalRels, 'Relationship').find((rel) => rel.getAttribute('Id') === attribute.value)
          if (!sourceRel) continue
          if (!candidateRels) candidateRels = parseXml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', relPath)
          const currentRel = descendants(candidateRels, 'Relationship').find((rel) => rel.getAttribute('Id') === attribute.value)
          if (currentRel && canonical(currentRel) !== canonical(sourceRel)) throw new Error(`Protected relationship ${part}#${attribute.value} conflicts with an edited object.`)
          if (!currentRel) { candidateRels.documentElement!.appendChild(candidateRels.importNode(sourceRel, true)); changed = true }
        }
      }
    }
    candidate.file(part, serializer.serializeToString(candidateDoc))
    if (candidateRels) candidate.file(relPath, serializer.serializeToString(candidateRels))
  }
  if (!changed) return Buffer.from(candidateBytes)
  candidate.file('[Content_Types].xml', serializer.serializeToString(candidateTypes))
  return candidate.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
