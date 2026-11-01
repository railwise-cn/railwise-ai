import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { buildWriteExportHtmlDocument, renderWriteExportHtmlToPdf } from '/Users/wangjiawei/Documents/WorkWise/src/main/services/write-export-service'
import { buildDocxFromMarkdown } from '/Users/wangjiawei/Documents/WorkWise/src/main/services/write-docx-service'
import { renderWriteMathImage, renderWriteMermaidDiagrams } from '/Users/wangjiawei/Documents/WorkWise/src/main/services/write-advanced-renderer'
async function run(){
const root='/private/tmp/railwise-advanced-export-smoke-20261101'
app.setPath('userData',join(root,'user-data'))
app.setPath('sessionData',join(root,'session-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed',()=>{})
await app.whenReady()
try {
  await mkdir(root,{recursive:true})
  const diagram='flowchart LR\n A[资料] --> B[草稿] --> C[审定]\n'
  const content='---\ntitle: 高级排版\n---\n\n# 高级 Markdown 导出\n\n结果 $s=\\sqrt{\\frac{\\sum_{i=1}^{n}v_i^2}{n-1}}$，详见注释[^check]。\n\n$$\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}\\begin{bmatrix}x\\\\y\\end{bmatrix}=\\begin{bmatrix}a\\\\b\\end{bmatrix}$$\n\n```mermaid\n'+diagram+'```\n\n[^check]: 复核依据包含 **加粗** 和 $x^2$。\n'
  const sourcePath=join(root,'advanced.md')
  await writeFile(sourcePath,content)
  const diagrams=await renderWriteMermaidDiagrams([diagram])
  const rendered=diagrams.get(diagram)
  if(!rendered)throw new Error('Expected local Mermaid diagram render failed')
  await writeFile(join(root,'diagram.svg'),rendered.svg)
  await writeFile(join(root,'diagram.png'),rendered.png)
  const mathImage=await renderWriteMathImage('\\boxed{x+1}',true)
  if(!mathImage)throw new Error('Expected offline math image fallback')
  await writeFile(join(root,'boxed-formula.png'),mathImage.png)
  const html=await buildWriteExportHtmlDocument({sourcePath,workspaceRoot:root,content})
  await writeFile(join(root,'advanced.html'),html)
  const docx=await buildDocxFromMarkdown({sourcePath,workspaceRoot:root,content})
  await writeFile(join(root,'advanced.docx'),docx)
  const pdf=await renderWriteExportHtmlToPdf(html)
  await writeFile(join(root,'advanced.pdf'),pdf)
  const result={electron:process.versions.electron,diagram:{width:rendered.width,height:rendered.height,pngBytes:rendered.png.length,svgBytes:Buffer.byteLength(rendered.svg)},html:{bytes:Buffer.byteLength(html),hasMath:html.includes('class="katex"'),hasSvg:html.includes('<svg'),hasFootnotes:html.includes('class="footnotes"'),hasRemoteFonts:/url\(["']?https?:/.test(html)},docx:{bytes:docx.length,sha256:createHash('sha256').update(docx).digest('hex')},pdf:{bytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex')}}
  await writeFile(join(root,'result.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result))
}catch(error){console.error(error);process.exitCode=1}finally{app.quit()}
}
void run()
