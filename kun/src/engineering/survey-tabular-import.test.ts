import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import JSZip from 'jszip'
import { describe, expect, it, onTestFinished } from 'vitest'
import { SURVEY_TABULAR_MAPPING_MAX_BYTES, SurveyTabularMappingV1 } from '../contracts/survey-tabular.js'
import { SurveySourceFileCreateV1 } from '../contracts/survey.js'
import { SurveyFormatRegistry } from './survey-format-registry.js'
import { rawAnchorDigest } from './survey-raw-data-ledger.js'
import { parseSurveyTabular, probeSurveyTabular } from './survey-tabular-import.js'
import { SurveyService } from './survey-service.js'
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const csv = Buffer.from('\uFEFFid,from,to,value,length\r\n"往\n测",BM,P,1000,100\r\nback,P,BM,-999,100\r\n')
function mapping(bytes: Buffer, tableId = 'csv'): SurveyTabularMappingV1 {
  return SurveyTabularMappingV1.parse({ schemaVersion: 'survey-tabular-mapping/v1', mappingId: 'explicit-mapping', revision: 1,
    sourceSha256: digest(bytes), tableId, headerRow: 1, delimiter: ',', networkType: 'leveling', observationType: 'height-difference',
    bindings: ['id','from','to','value','routeLength'].map((field,columnIndex) => ({ field,columnIndex })),
    linearUnit: 'mm', angularUnit: 'rad', routeLengthUnit: 'm', coordinateSystem: 'LOCAL', verticalDatum: 'BM-local',
    knownPoints: [{ id:'BM',height:10 }], confirmed:true })
}
async function workbook(formula = false, options: { worksheetRelationshipType?: string; worksheetTarget?: string } = {}): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>')
  zip.file('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="隐藏测站记录" sheetId="8" state="hidden" r:id="rHidden"/><sheet name="观测记录" sheetId="3" r:id="rObservations"/><sheet name="说明" sheetId="4" r:id="rNotes"/><sheet name="内部计算" sheetId="9" state="veryHidden" r:id="rInternal"/></sheets></workbook>')
  const transitionalWorksheet = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
  const relationshipType = options.worksheetRelationshipType ?? transitionalWorksheet
  const observationTarget = options.worksheetTarget ?? 'worksheets/observation-data.xml'
  zip.file('xl/_rels/workbook.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rInternal" Type="${transitionalWorksheet}" Target="worksheets/internal-calc.xml"/><Relationship Id="rObservations" Type="${relationshipType}" Target="${observationTarget}"/><Relationship Id="rHidden" Type="${transitionalWorksheet}" Target="worksheets/hidden-stations.xml"/><Relationship Id="rNotes" Type="${transitionalWorksheet}" Target="worksheets/notes.xml"/></Relationships>`)
  const rows = [['id','from','to','value','length'],['forward','BM','P','1000','100'],['back','P','BM','-999','100']]
  const xml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row,r) => `<row r="${r+1}">${row.map((cell,c) => `<c r="${String.fromCharCode(65+c)}${r+1}" t="inlineStr">${formula&&r===1&&c===3?'<f>1+1</f>':''}<is><t>${cell}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`
  zip.file('xl/worksheets/observation-data.xml',xml)
  zip.file('xl/worksheets/hidden-stations.xml','<worksheet/>')
  zip.file('xl/worksheets/notes.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>')
  zip.file('xl/worksheets/internal-calc.xml','<worksheet/>')
  return await zip.generateAsync({ type:'nodebuffer',compression:'DEFLATE' })
}

describe('confirmed source-bound tabular measurement inputs',() => {
  it('preserves CSV multiline UTF-8 byte anchors, canonical units and retained mapping',async () => {
    const probe = await probeSurveyTabular('survey.csv',csv)
    expect(probe).toMatchObject({ sourceSha256:digest(csv),delimiter:',',tables:[{rowCount:2}] })
    const parsed = await parseSurveyTabular('survey.csv',csv,mapping(csv))
    expect(parsed.observations[0]).toMatchObject({ id:'往\n测',value:1,unit:'m',routeLength:100 })
    expect(parsed.observations[1]!.value).toBeCloseTo(-0.999,12)
    expect(parsed.anchors.map(anchor => csv.subarray(anchor.rawOffset,anchor.rawOffset+anchor.rawLength).toString('utf8'))).toEqual(['"往\n测",BM,P,1000,100\r\n','back,P,BM,-999,100\r\n'])
    expect(JSON.parse(parsed.sourceRawFields['tabular.mapping']!)).toEqual(mapping(csv))
    await expect(parseSurveyTabular('survey.csv',csv,{...mapping(csv),sourceSha256:'0'.repeat(64)})).rejects.toThrow('hash')
    await expect(parseSurveyTabular('survey.csv',csv,{...mapping(csv),confirmed:false} as unknown as SurveyTabularMappingV1)).rejects.toThrow()
  })

  it('retains the prior network when the same CSV is reimported with a newly confirmed reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'survey-tabular-reference-'))
    const service = new SurveyService({ rootDir: root }); onTestFinished(() => service.close())
    const originalMapping = mapping(csv)
    const original = await service.importNetwork({
      projectId: 'tabular-reference', expectedRevision: 0, idempotencyKey: 'reference-original',
      name: 'survey.csv', dataBase64: csv.toString('base64'), tabularMapping: originalMapping,
      referenceDeclaration: { coordinateSystem: 'LOCAL', verticalDatum: 'BM-local' }
    })
    const revisedMapping = SurveyTabularMappingV1.parse({ ...originalMapping, coordinateSystem: 'LOCAL-2' })
    const revised = await service.importNetwork({
      projectId: 'tabular-reference', expectedRevision: 0, idempotencyKey: 'reference-revised',
      name: 'survey.csv', dataBase64: csv.toString('base64'), tabularMapping: revisedMapping,
      referenceDeclaration: { coordinateSystem: 'LOCAL-2', verticalDatum: 'BM-local' }
    })

    expect(revised.id).not.toBe(original.id)
    expect(revised.coordinateSystem).toBe('LOCAL-2')
    expect(service.getNetwork(original.id)?.coordinateSystem).toBe('LOCAL')
    expect(service.listNetworks('tabular-reference').map(network => network.id)).toEqual(expect.arrayContaining([original.id, revised.id]))
  })

  it('binds XLSX row addresses to the original ZIP member and uncompressed bytes',async () => {
    const bytes = await workbook()
    const probe = await probeSurveyTabular('survey.xlsx',bytes)
    expect(probe.tables).toMatchObject([
      { id: 'xl/worksheets/hidden-stations.xml', name: '隐藏测站记录', visibility: 'hidden', importable: false, columns: [], rowCount: 0 },
      { id: 'xl/worksheets/observation-data.xml', name: '观测记录', visibility: 'visible', importable: true, columns: ['id','from','to','value','length'], rowCount: 2 },
      { id: 'xl/worksheets/notes.xml', name: '说明', visibility: 'visible', importable: false, columns: [], rowCount: 0 },
      { id: 'xl/worksheets/internal-calc.xml', name: '内部计算', visibility: 'veryHidden', importable: false, columns: [], rowCount: 0 }
    ])
    const parsed = await parseSurveyTabular('survey.xlsx',bytes,mapping(bytes,'xl/worksheets/observation-data.xml'))
    const xml = await (await JSZip.loadAsync(bytes)).file('xl/worksheets/observation-data.xml')!.async('nodebuffer')
    expect(parsed.observations).toHaveLength(2)
    for (const anchor of parsed.anchors) {
      expect(anchor.rawOffset).toBeGreaterThan(0)
      expect(anchor.rawOffset+anchor.rawLength).toBeLessThan(bytes.length)
      const member=anchor.containerMember!
      expect(member.sha256).toBe(digest(xml))
      const row=xml.subarray(member.byteOffset,member.byteOffset+member.byteLength).toString('utf8')
      expect(row).toBe(anchor.rawSnippet)
      expect(row).toContain(`<row r="${member.row}">`)
    }
    await expect(parseSurveyTabular('survey.xlsx',bytes,mapping(bytes,'xl/worksheets/hidden-stations.xml'))).rejects.toThrow('Hidden worksheets')
    await expect(parseSurveyTabular('survey.xlsx',bytes,mapping(bytes,'xl/worksheets/notes.xml'))).rejects.toThrow('header and 1 to 100000 data rows')
    const formulaWorkbook = await workbook(true)
    await expect(parseSurveyTabular('survey.xlsx',formulaWorkbook,mapping(formulaWorkbook,'xl/worksheets/observation-data.xml'))).rejects.toThrow('Formulas')
  })

  it('accepts only standard OOXML worksheet relationship URIs and resolves safe target forms',async () => {
    const strictType = 'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet'
    for (const worksheetTarget of ['/xl/worksheets/observation-data.xml', './worksheets/observation-data.xml', 'worksheets/observation%2Ddata.xml']) {
      const bytes = await workbook(false, { worksheetRelationshipType: strictType, worksheetTarget })
      const probe = await probeSurveyTabular('survey.xlsx', bytes)
      expect(probe.tables.find((table) => table.name === '观测记录')).toMatchObject({ id: 'xl/worksheets/observation-data.xml', importable: true, rowCount: 2 })
    }

    const invalidType = await workbook(false, { worksheetRelationshipType: 'https://example.invalid/worksheet' })
    await expect(probeSurveyTabular('survey.xlsx', invalidType)).rejects.toThrow('Unsupported workbook sheet relationship type')

    const escapingTarget = await workbook(false, { worksheetTarget: '../../outside.xml' })
    await expect(probeSurveyTabular('survey.xlsx', escapingTarget)).rejects.toThrow('escapes the package root')
  })

  it('retains archive-only unconfirmed tables and strictly rechecks confirmed source admission',async () => {
    const root = await mkdtemp(join(tmpdir(),'survey-tabular-'))
    const service = new SurveyService({rootDir:root}); onTestFinished(()=>service.close())
    const bytes=await workbook()
    const archived=await service.importNetwork({projectId:'tabular',expectedRevision:0,idempotencyKey:'tabular-archive',name:'survey.xlsx',dataBase64:bytes.toString('base64')})
    expect(archived.sourceFile?.disposition).toBe('archive-only')
    expect(archived.observations).toHaveLength(0)
    expect(service.getSourceEligibility(archived.id).eligible).toBe(false)
    for (const [name,source] of [['survey.csv',csv],['survey.xlsx',bytes]] as const) {
      const imported=await service.importNetwork({projectId:'tabular',expectedRevision:0,idempotencyKey:`tabular-import-${name}`,name,dataBase64:source.toString('base64'),tabularMapping:mapping(source,name.endsWith('xlsx')?'xl/worksheets/observation-data.xml':'csv')})
      expect(imported.sourceFile?.disposition).toBe('adjustment-ready')
      expect(imported.sourceFile?.tabularMapping).toEqual(mapping(source,name.endsWith('xlsx')?'xl/worksheets/observation-data.xml':'csv'))
      expect(await readFile(join(root,'sources',digest(source),'original'))).toEqual(source)
      expect(service.getRawSourceIntegrity(imported.id).status).toBe('verified')
      expect(service.getSourceEligibility(imported.id).eligible).toBe(true)
      const checked=service.validateNetwork(imported.id,{expectedRevision:imported.revision,idempotencyKey:`tabular-check-${name}`})
      const output=service.createAdjustment({networkId:imported.id,expectedRevision:checked.revision,idempotencyKey:`tabular-adjust-${name}`})
      expect(service.getProfessionalReview(output.run.id)?.source).toMatchObject({status:'bound',integrity:'verified',anchoredObservationCount:2})
      const database=new Database(join(root,'survey.sqlite3')); onTestFinished(()=>{database.close()})
      const network=service.getNetwork(imported.id)!
      const records=network.sourceFile!.records.map((record,i)=>i===0?{...record,rawOffset:0}:record)
      database.prepare('UPDATE survey_networks SET data_json=? WHERE id=?').run(JSON.stringify({...network,sourceFile:{...network.sourceFile,records}}),network.id)
      expect(service.getSourceEligibility(imported.id).eligible).toBe(false)
      expect(service.getAdjustment(output.run.id)?.result).toEqual(output.result)
      expect(()=>service.getAdjustmentForProjectNewUse('tabular',output.run.id)).toThrow()
    }
  })

  it('rejects conflicting mappings, invalid numbers, formulas and expansion bombs',async () => {
    expect(SurveyTabularMappingV1.safeParse({...mapping(csv),knownPoints:[{id:'BM',height:10},{id:'BM',height:12}]}).success).toBe(false)
    expect(SurveyTabularMappingV1.safeParse({...mapping(csv),verticalDatum:'pending'}).success).toBe(false)
    const invalid=Buffer.from('from,to,value\nBM,P,NaN\nP,BM,0\n')
    await expect(parseSurveyTabular('bad.csv',invalid,{...mapping(invalid),bindings:[{field:'from',columnIndex:0},{field:'to',columnIndex:1},{field:'value',columnIndex:2}]})).rejects.toThrow('Invalid value at row 2')
    const zip=new JSZip(); zip.file('bomb',Buffer.alloc(500000,'x'))
    await expect(probeSurveyTabular('bomb.xlsx',await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))).rejects.toThrow('expansion')
  })

  it('retains a complete confirmed mapping even when optional per-observation fields reach their limit',async () => {
    const bytes=Buffer.from(`id,from,to,value,length\n${Array.from({length:4000},(_,index)=>`obs-${index},${index%2?'P':'BM'},${index%2?'BM':'P'},${index%2?-1000:1000},100`).join('\n')}\n`)
    const declaration={...mapping(bytes),knownPoints:Array.from({length:100},(_,index)=>({id:index===0?'BM':`control-${index}-${'a'.repeat(80)}`,height:10+index}))}
    const input=SurveyTabularMappingV1.parse(declaration)
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(2048)
    const source=await new SurveyFormatRegistry().ingest({name:'large.csv',bytes,tabularMapping:input})
    expect(source.sourceFile.disposition).toBe('adjustment-ready')
    expect(source.sourceFile.diagnostics).toContainEqual(expect.objectContaining({code:'limit_exceeded',severity:'warning'}))
    expect(source.sourceFile.tabularMapping).toEqual(input)
    expect(source.sourceFile.preservedRawFields['source:tabular.mapping']).toBe(JSON.stringify(input))
    expect(JSON.parse(JSON.stringify(source.sourceFile)).tabularMapping.knownPoints).toEqual(input.knownPoints)
    const {tabularMapping:_removed,...withoutConfirmation}=source.sourceFile
    expect(SurveySourceFileCreateV1.safeParse(withoutConfirmation).success).toBe(false)
    expect(SurveySourceFileCreateV1.safeParse({...source.sourceFile,tabularMapping:{...input,sourceSha256:'0'.repeat(64)}}).success).toBe(false)
  })

  it('rejects oversized mappings before ingestion and leaves durable networks empty',async () => {
    const declaration={...mapping(csv),knownPoints:Array.from({length:5000},(_,index)=>({id:`control-${index}-${'x'.repeat(185)}`,height:index}))}
    expect(Buffer.byteLength(JSON.stringify(declaration))).toBeGreaterThan(SURVEY_TABULAR_MAPPING_MAX_BYTES)
    expect(SurveyTabularMappingV1.safeParse(declaration).success).toBe(false)
    const root=await mkdtemp(join(tmpdir(),'survey-tabular-map-limit-'))
    const service=new SurveyService({rootDir:root}); onTestFinished(()=>service.close())
    await expect(service.importNetwork({projectId:'tabular',expectedRevision:0,idempotencyKey:'oversized-mapping',name:'survey.csv',dataBase64:csv.toString('base64'),tabularMapping:declaration})).rejects.toThrow('exceeds')
    expect(service.listNetworks()).toHaveLength(0)
  })

  it('binds member path, digest and row range into the immutable raw-source ledger',async () => {
    const bytes=await workbook()
    const parsed=await parseSurveyTabular('survey.xlsx',bytes,mapping(bytes,'xl/worksheets/observation-data.xml'))
    const evidence={sha256:digest(bytes),fileSize:bytes.length,originalPreserved:true,records:parsed.anchors}
    const original=rawAnchorDigest(evidence)
    const altered={...evidence,records:evidence.records.map((record,index)=>index===0?{...record,containerMember:{...record.containerMember!,byteOffset:record.containerMember!.byteOffset+1}}:record)}
    expect(rawAnchorDigest(altered)).not.toBe(original)
    expect(()=>rawAnchorDigest({...evidence,records:[{...parsed.anchors[0]!,containerMember:{...parsed.anchors[0]!.containerMember!,path:'../outside'}}]})).toThrow('container member')
  })

  it('revokes fresh use when the persisted complete mapping is changed, while preserving historical results',async () => {
    const root=await mkdtemp(join(tmpdir(),'survey-tabular-map-tamper-'))
    const service=new SurveyService({rootDir:root}); onTestFinished(()=>service.close())
    const imported=await service.importNetwork({projectId:'tabular',expectedRevision:0,idempotencyKey:'mapping-provenance',name:'survey.csv',dataBase64:csv.toString('base64'),tabularMapping:mapping(csv)})
    const checked=service.validateNetwork(imported.id,{expectedRevision:imported.revision,idempotencyKey:'mapping-check'})
    const output=service.createAdjustment({networkId:imported.id,expectedRevision:checked.revision,idempotencyKey:'mapping-adjust'})
    const database=new Database(join(root,'survey.sqlite3')); onTestFinished(()=>{database.close()})
    const current=service.getNetwork(imported.id)!
    database.prepare('UPDATE survey_networks SET data_json=? WHERE id=?').run(JSON.stringify({...current,sourceFile:{...current.sourceFile,tabularMapping:{...current.sourceFile!.tabularMapping,knownPoints:[{id:'BM',height:20}]}}}),current.id)
    expect(service.getSourceEligibility(current.id).eligible).toBe(false)
    expect(service.getAdjustment(output.run.id)?.result).toEqual(output.result)
    expect(()=>service.getAdjustmentForProjectNewUse('tabular',output.run.id)).toThrow()
  })
})
