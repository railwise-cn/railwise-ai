import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'

/** Small real OOXML deck: rich text, merged table, native chart and SmartArt. */
export async function createPptxRegressionFixture() {
  const zip = new JSZip()
  const p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const c = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
  const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const relationships = (items) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${r}/${type}" Target="${target}"/>`).join('')}</Relationships>`
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`)
  zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'ppt/presentation.xml']]))
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', relationships([['rId1', 'slide', 'slides/slide1.xml']]))
  const frame = (id, name, x, y, width, height, data) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></p:xfrm><a:graphic>${data}</a:graphic></p:graphicFrame>`
  const cell = (text, attrs = '') => `<a:tc ${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1800"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`
  const table = frame(3, 'Merged table', 400000, 1500000, 5000000, 1600000,
    `<a:graphicData uri="${a}/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid><a:gridCol w="2500000"/><a:gridCol w="2500000"/></a:tblGrid><a:tr h="800000">${cell('合并标题', 'gridSpan="2"')}${cell('', 'hMerge="1"')}</a:tr><a:tr h="800000">${cell('指标')}${cell('42')}</a:tr></a:tbl></a:graphicData>`)
  const chart = frame(4, 'Native chart', 6000000, 1500000, 5000000, 3500000,
    `<a:graphicData uri="${c}"><c:chart xmlns:c="${c}" r:id="rIdChart"/></a:graphicData>`)
  const smartArt = frame(5, 'Protected SmartArt', 400000, 3500000, 4000000, 1500000,
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rIdDiagram"/></a:graphicData>`)
  zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${r}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="400000" y="250000"/><a:ext cx="10000000" cy="900000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="3200" b="1"><a:solidFill><a:srgbClr val="2455AA"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>RailWise regression</a:t></a:r><a:r><a:rPr sz="3200"/><a:t> — 原生编辑</a:t></a:r></a:p></p:txBody></p:sp>${table}${chart}${smartArt}</p:spTree></p:cSld></p:sld>`)
  zip.file('ppt/slides/_rels/slide1.xml.rels', relationships([['rIdChart', 'chart', '../charts/chart1.xml'], ['rIdDiagram', 'diagramData', '../diagrams/data1.xml']]))
  zip.file('ppt/charts/chart1.xml', `<c:chartSpace xmlns:c="${c}" xmlns:a="${a}"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Series 1</c:v></c:tx><c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`)
  zip.file('ppt/diagrams/data1.xml', '<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:ptLst><dgm:pt modelId="0" type="doc"/></dgm:ptLst><dgm:cxnLst/></dgm:dataModel>')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.argv[2]
  if (!output) throw new Error('Usage: node scripts/create-pptx-regression-fixture.mjs /path/to/fixture.pptx')
  await writeFile(output, await createPptxRegressionFixture())
  process.stdout.write(`PPTX regression fixture written: ${output}\n`)
}
