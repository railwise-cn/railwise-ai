import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { EngineeringService } from './engineering-service.js'
import type { EngineeringContextService } from './engineering-context-service.js'
import type { FlowRuntimeService } from '../flow/service.js'
import type { FlowRepository } from '../flow/repository.js'
import type { FlowNodeAdapter } from '../flow/executor.js'
import type { FlowDefinitionV1 } from '../contracts/flow.js'
import { SurveyCollaborationDraftV1, SurveyDraftCreateV1, SurveyDraftReferenceV1, SurveyDraftExportV1 } from '../contracts/survey-collaboration.js'
import { makeProfessionalDocx, makeProfessionalXlsx, professionalReportPresentation, type ProfessionalReportModel } from './survey-professional-report.js'
import { makeProfessionalReportPdf } from './engineering-report-pdf.js'
import { surveyDesignSvg } from './survey-design-export.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const modelSchema = z.object({ title: z.string(), projectName: z.string(), taskType: z.string(), generatedAt: z.string(), reviewStatus: z.literal('unsigned'), reportStatus: z.literal('draft'), sourceBinding: z.array(z.unknown()), tables: z.array(z.object({id:z.string(),title:z.string(),columns:z.array(z.object({key:z.string(),label:z.string(),unit:z.string().optional()}).passthrough()),rows:z.array(z.record(z.string(),z.union([z.string(),z.number().finite(),z.boolean(),z.null()]))),note:z.string().optional()}).passthrough()), notes: z.array(z.string()), signoff: z.array(z.unknown()) }).passthrough()
type StoredDraft = { draft: SurveyCollaborationDraftV1; model: ProfessionalReportModel; requestKey: string }
export class SurveyCollaborationError extends Error {
  constructor(readonly reason: 'stale' | 'not-found' | 'validation' | 'approval' | 'unavailable' | 'integrity') { super(reason) }
}

/** The editor files are new drafts. No edit ever mutates the verified source package. */
export class SurveyCollaborationService {
  private readonly db: Database.Database
  private readonly pending = new Map<string, Promise<unknown>>()
  constructor(path: string, private readonly engineering: Pick<EngineeringService,'getProject'|'getManifestForProject'|'verifyDeliverable'>,
    private readonly context: Pick<EngineeringContextService,'snapshot'>, private readonly now = () => new Date().toISOString()) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec('CREATE TABLE IF NOT EXISTS survey_collaboration_drafts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_key TEXT NOT NULL, record_hash TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(project_id, request_key)); CREATE TABLE IF NOT EXISTS survey_collaboration_exports (operation_key TEXT PRIMARY KEY, record_hash TEXT NOT NULL, record_json TEXT NOT NULL);')
  }
  close(): void { this.db.close() }
  private serial<T>(key:string, action:()=>Promise<T>):Promise<T> {
    const previous=this.pending.get(key) ?? Promise.resolve()
    const next=previous.catch(()=>undefined).then(action)
    this.pending.set(key,next)
    void next.finally(()=>{if(this.pending.get(key)===next)this.pending.delete(key)}).catch(()=>undefined)
    return next
  }
  private read(projectId:string,id:string):StoredDraft {
    const row=this.db.prepare('SELECT record_hash, record_json FROM survey_collaboration_drafts WHERE id=? AND project_id=?').get(id,projectId) as {record_hash:string;record_json:string}|undefined
    if(!row)throw new SurveyCollaborationError('not-found')
    if(sha(row.record_json)!==row.record_hash)throw new SurveyCollaborationError('integrity')
    const value=JSON.parse(row.record_json) as StoredDraft
    value.draft=SurveyCollaborationDraftV1.parse(value.draft)
    if(value.draft.id!==id||value.draft.projectId!==projectId)throw new SurveyCollaborationError('integrity')
    return value
  }
  private save(value:StoredDraft):void {
    const data=JSON.stringify(value)
    this.db.prepare('INSERT INTO survey_collaboration_drafts(id,project_id,request_key,record_hash,record_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_hash=excluded.record_hash,record_json=excluded.record_json').run(value.draft.id,value.draft.projectId,value.requestKey,sha(data),data)
  }
  private async directory(workspace:string,target:string):Promise<string> {
    const root=await realpath(workspace), rel=relative(resolve(workspace),resolve(workspace,target)),candidate=resolve(root,rel)
    if(!rel||rel==='..'||rel.startsWith(`..${sep}`))throw new SurveyCollaborationError('integrity')
    let current=root
    for(const part of rel.split(sep).filter(Boolean)){
      current=join(current,part)
      try {
        const stat=await lstat(current)
        if(stat.isSymbolicLink()||!stat.isDirectory())throw new SurveyCollaborationError('integrity')
      } catch(error) {
        if(error instanceof SurveyCollaborationError)throw error
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
        await mkdir(current)
        const stat=await lstat(current)
        if(stat.isSymbolicLink()||!stat.isDirectory())throw new SurveyCollaborationError('integrity')
      }
    }
    const verified=await realpath(candidate)
    if(verified!==candidate)throw new SurveyCollaborationError('integrity')
    return candidate
  }
  private async removeDirectory(workspace:string,target:string):Promise<void> {
    try {
      const root=await realpath(workspace), rel=relative(resolve(workspace),resolve(workspace,target)),candidate=resolve(root,rel)
      if(!rel||rel==='..'||rel.startsWith(`..${sep}`))return
      const verified=await realpath(candidate)
      if(verified!==candidate)return
      await rm(candidate,{recursive:true,force:true})
    } catch { /* cleanup must never follow or remove an external path */ }
  }
  list(projectId:string):SurveyCollaborationDraftV1[] {
    return (this.db.prepare('SELECT id FROM survey_collaboration_drafts WHERE project_id=? ORDER BY rowid DESC LIMIT 30').all(projectId) as Array<{id:string}>).map(item=>this.read(projectId,item.id).draft)
  }
  get(projectId:string,id:string):SurveyCollaborationDraftV1 { return this.read(projectId,id).draft }
  resolveEditor(workspace:string,path?:string,documentId?:string):SurveyCollaborationDraftV1|null {
    if(workspace.length>4096||(!path&&!documentId)||path&&path.length>4096||documentId&&documentId.length>180)throw new SurveyCollaborationError('validation')
    const rows=this.db.prepare('SELECT id,project_id FROM survey_collaboration_drafts WHERE json_extract(record_json,\'$.draft.workspace\')=? ORDER BY rowid DESC LIMIT 1000').all(workspace) as Array<{id:string;project_id:string}>
    const matches=rows.map(row=>this.get(row.project_id,row.id)).filter(draft=>path?resolve(workspace,path)===resolve(workspace,draft.notesPath):draft.designDocumentId===documentId)
    if(matches.length>1)throw new SurveyCollaborationError('integrity')
    return matches[0]??null
  }
  private source(draft:Pick<SurveyCollaborationDraftV1,'projectId'|'projectRevision'|'workspace'|'manifestId'|'manifestHash'|'contextHash'>):void {
    const project=this.engineering.getProject(draft.projectId),manifest=this.engineering.getManifestForProject(draft.projectId,draft.manifestId)
    if(!project||project.revision!==draft.projectRevision||project.workspace!==draft.workspace||!manifest||sha(JSON.stringify(manifest))!==draft.manifestHash||this.context.snapshot(draft.projectId).contextHash!==draft.contextHash)throw new SurveyCollaborationError('stale')
    if(!this.engineering.verifyDeliverable(draft.projectId,draft.manifestId).valid)throw new SurveyCollaborationError('stale')
  }
  private async path(workspace:string,target:string,exists=true):Promise<string> {
    const root=await realpath(workspace), candidate=resolve(workspace,target),rel=relative(resolve(workspace),candidate)
    if(!rel||rel==='..'||rel.startsWith(`..${sep}`))throw new SurveyCollaborationError('integrity')
    const parent=await realpath(dirname(candidate)),parentRel=relative(root,parent)
    if(parentRel==='..'||parentRel.startsWith(`..${sep}`))throw new SurveyCollaborationError('integrity')
    if(exists){const stat=await lstat(candidate);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw new SurveyCollaborationError('integrity')}
    else {try{await lstat(candidate);throw new SurveyCollaborationError('integrity')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
    return candidate
  }
  private async file(workspace:string,target:string):Promise<Buffer> { return readFile(await this.path(workspace,target)) }
  async create(projectId:string,raw:unknown):Promise<SurveyCollaborationDraftV1> {
    const input=SurveyDraftCreateV1.parse(raw)
    return this.serial(projectId,async()=>{
      const duplicate=this.db.prepare('SELECT id FROM survey_collaboration_drafts WHERE project_id=? AND request_key=?').get(projectId,input.idempotencyKey) as {id:string}|undefined
      if(duplicate){const existing=this.get(projectId,duplicate.id);if(existing.manifestId!==input.manifestId||existing.projectRevision!==input.expectedProjectRevision)throw new SurveyCollaborationError('validation');return existing}
      if(this.list(projectId).length>=30)throw new SurveyCollaborationError('validation')
      const project=this.engineering.getProject(projectId),manifest=this.engineering.getManifestForProject(projectId,input.manifestId)
      if(!project||!manifest)throw new SurveyCollaborationError('not-found')
      if(project.revision!==input.expectedProjectRevision)throw new SurveyCollaborationError('stale')
      const source={projectId,projectRevision:project.revision,workspace:project.workspace,manifestId:manifest.id,manifestHash:sha(JSON.stringify(manifest)),contextHash:this.context.snapshot(projectId).contextHash}
      this.source(source)
      const projection=manifest.outputs.filter(item=>item.path.endsWith('/professional-review.json')||item.path==='professional-review.json')
      if(projection.length!==1)throw new SurveyCollaborationError('unavailable')
      const bytes=await this.file(project.workspace,projection[0]!.path)
      if(sha(bytes)!==projection[0]!.sha256)throw new SurveyCollaborationError('integrity')
      const rawModel=(JSON.parse(bytes.toString('utf8')) as {model:unknown}).model
      modelSchema.parse(rawModel)
      const model=rawModel as ProfessionalReportModel
      const id=`survey_draft_${randomUUID()}`,docId=`doc_survey_${randomUUID().replaceAll('-','')}`,createdAt=this.now()
      const notesPath=join('.workwise','survey-drafts',id,'review-notes.md'),designPath=join('.workwise','design',`${docId}.workwise-design.json`)
      await this.directory(project.workspace,dirname(notesPath));await this.directory(project.workspace,dirname(designPath))
      const notes=`# ${project.name} — 专业复核补充说明\n\n本页为独立待审草稿。原成果数值表与原始记录保持在所选成果中；这里补充复核意见、问题处理和交付说明。\n\n## 复核说明\n\n请填写需说明的专业事项。\n`
      const design=JSON.stringify(designDraft(docId,model),null,2)+'\n'
      await writeFile(await this.path(project.workspace,notesPath,false),notes,{flag:'wx'});await writeFile(await this.path(project.workspace,designPath,false),design,{flag:'wx'})
      this.source(source)
      const draft=SurveyCollaborationDraftV1.parse({...source,schemaVersion:1,id,projectName:project.name,revision:1,notesPath,designPath,designDocumentId:docId,notesHash:sha(notes),designHash:sha(design),contentHash:sha(JSON.stringify([source,sha(notes),sha(design)])),createdAt,updatedAt:createdAt,status:'draft',professionalSignature:'unsigned'})
      this.save({draft,model,requestKey:input.idempotencyKey});return draft
    })
  }
  async seal(projectId:string,id:string,expectedRevision:number):Promise<SurveyCollaborationDraftV1> {
    return this.serial(projectId,async()=>{
      const value=this.read(projectId,id),draft=value.draft
      if(draft.revision!==expectedRevision)throw new SurveyCollaborationError('stale')
      this.source(draft)
      const notesHash=sha(await this.file(draft.workspace,draft.notesPath)),designHash=sha(await this.file(draft.workspace,draft.designPath))
      if(notesHash!==draft.notesHash||designHash!==draft.designHash){
        const {flowId:_flow,runId:_run,...current}=draft
        value.draft={...current,notesHash,designHash,revision:draft.revision+1,contentHash:sha(JSON.stringify([draft.manifestHash,draft.contextHash,notesHash,designHash])),updatedAt:this.now()}
        this.save(value)
      }
      this.source(value.draft);return value.draft
    })
  }
  async check(reference:unknown):Promise<SurveyCollaborationDraftV1> {
    const ref=SurveyDraftReferenceV1.parse(reference),draft=this.get(ref.projectId,ref.draftId)
    if(draft.revision!==ref.revision||draft.contentHash!==ref.contentHash)throw new SurveyCollaborationError('stale')
    this.source(draft)
    if(sha(await this.file(draft.workspace,draft.notesPath))!==draft.notesHash||sha(await this.file(draft.workspace,draft.designPath))!==draft.designHash)throw new SurveyCollaborationError('stale')
    return draft
  }
  async startReview(projectId:string,id:string,expectedRevision:number,flow:FlowRuntimeService):Promise<SurveyCollaborationDraftV1> {
    const draft=await this.seal(projectId,id,expectedRevision)
    return this.serial(projectId,async()=>{
      const value=this.read(projectId,id)
      if(value.draft.contentHash!==draft.contentHash)throw new SurveyCollaborationError('stale')
      if(draft.flowId&&draft.runId){const previous=flow.runDetails(draft.runId);if(previous&&['queued','running','waiting_approval','paused','interrupted','succeeded'].includes(previous.run.status))return draft}
      const flowId=`flow_survey_${randomUUID().replaceAll('-','')}`
      const definition=reviewFlow(flowId,draft)
      flow.create(definition)
      if(!flow.publish(flowId).published)throw new SurveyCollaborationError('unavailable')
      const run=await flow.run(flowId,{projectId,draftId:id,revision:draft.revision,contentHash:draft.contentHash})
      value.draft={...draft,flowId,runId:run.id};this.save(value);return value.draft
    })
  }
  adapters(repository:FlowRepository):Map<string,FlowNodeAdapter> {
    return new Map<string,FlowNodeAdapter>([
      ['railwise.survey_draft_check',async({run})=>{const draft=await this.check(run.input);return{kind:'output',output:{draftId:draft.id,revision:draft.revision,summary:'来源与草稿已检查，等待本次交付确认。'}}}],
      ['railwise.survey_draft_export',async({run,definition,signal})=>{
        const draft=await this.check(run.input)
        if(draft.runId!==run.id||draft.flowId!==run.flowId)throw new SurveyCollaborationError('approval')
        const approval=definition.nodes.find(node=>node.id==='approval'&&node.type==='human_approval')
        const decided=repository.listNodeRuns(run.id).filter(node=>node.nodeId==='approval').at(-1)
        if(!approval||decided?.status!=='succeeded'||(decided.output as {decision?:unknown})?.decision!=='approve')throw new SurveyCollaborationError('approval')
        return {kind:'output',output:await this.exportDraft(run.input,run.id,signal)}
      }]
    ])
  }
  private async exportDraft(reference:unknown,operation:string,signal:AbortSignal):Promise<SurveyDraftExportV1> {
    const ref=SurveyDraftReferenceV1.parse(reference)
    return this.serial(ref.projectId,async()=>{
      const draft=await this.check(ref),value=this.read(ref.projectId,ref.draftId),key=sha(JSON.stringify([ref.projectId,ref.draftId,operation,ref.contentHash]))
      const dir=join('.workwise','survey-drafts',draft.id,`exports-${sha(operation).slice(0,20)}`)
      const names=['review-draft.docx','review-draft.pdf','review-draft.xlsx','figure-draft.svg'],types=['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/svg+xml']
      if(signal.aborted)throw new SurveyCollaborationError('stale')
      const old=this.db.prepare('SELECT record_hash,record_json FROM survey_collaboration_exports WHERE operation_key=?').get(key) as {record_hash:string;record_json:string}|undefined
      if(old){
        if(sha(old.record_json)!==old.record_hash)throw new SurveyCollaborationError('integrity')
        const receipt=SurveyDraftExportV1.parse(JSON.parse(old.record_json))
        if(receipt.draftId!==draft.id||receipt.revision!==draft.revision||receipt.contentHash!==draft.contentHash)throw new SurveyCollaborationError('integrity')
        if(receipt.files.length!==names.length)throw new SurveyCollaborationError('integrity')
        for(const [index,f] of receipt.files.entries()){
          if(f.path!==join(dir,names[index]!)||f.mediaType!==types[index])throw new SurveyCollaborationError('integrity')
          const bytes=await this.file(draft.workspace,f.path)
          if(bytes.length!==f.sizeBytes||sha(bytes)!==f.sha256)throw new SurveyCollaborationError('integrity')
        }
        return receipt
      }
      const notesBytes=await this.file(draft.workspace,draft.notesPath),designBytes=await this.file(draft.workspace,draft.designPath)
      if(sha(notesBytes)!==draft.notesHash||sha(designBytes)!==draft.designHash)throw new SurveyCollaborationError('stale')
      const notes=notesBytes.toString('utf8')
      const model:ProfessionalReportModel={...value.model,generatedAt:this.now(),reviewStatus:'unsigned',reportStatus:'draft',notes:[...value.model.notes,'以下补充说明由编辑草稿提供，需专业复核：',notes],signoff:value.model.signoff.map(item=>({...item,name:'',date:'',signature:''}))}
      const design=JSON.parse(designBytes.toString('utf8'))
      const buffers=[await makeProfessionalDocx(model),await makeProfessionalReportPdf(model),await makeProfessionalXlsx(model),Buffer.from(surveyDesignSvg(design))]
      await this.check(ref)
      const finalNotes=await this.file(draft.workspace,draft.notesPath),finalDesign=await this.file(draft.workspace,draft.designPath)
      if(sha(finalNotes)!==sha(notesBytes)||sha(finalDesign)!==sha(designBytes))throw new SurveyCollaborationError('stale')
      if(signal.aborted)throw new SurveyCollaborationError('stale')
      await this.directory(draft.workspace,dir)
      const files:SurveyDraftExportV1['files']=[]
      try {
        for(let index=0;index<buffers.length;index++){const path=join(dir,names[index]!),bytes=buffers[index]!;await writeFile(await this.path(draft.workspace,path,false),bytes,{flag:'wx'});files.push({path,mediaType:types[index]!,sha256:sha(bytes),sizeBytes:bytes.length})}
        await this.check(ref)
        if(signal.aborted)throw new SurveyCollaborationError('stale')
        const receipt=SurveyDraftExportV1.parse({schemaVersion:1,draftId:draft.id,revision:draft.revision,contentHash:draft.contentHash,reviewStatus:'draft',professionalSignature:'unsigned',files})
        const serialized=JSON.stringify(receipt)
        this.db.prepare('INSERT INTO survey_collaboration_exports(operation_key,record_hash,record_json) VALUES(?,?,?)').run(key,sha(serialized),serialized)
        return receipt
      } catch(e) {await this.removeDirectory(draft.workspace,dir);throw e}
    })
  }
}

function reviewFlow(id:string,draft:SurveyCollaborationDraftV1):Omit<FlowDefinitionV1,'revision'|'createdAt'|'updatedAt'> {
  const types=['manual_trigger','railwise.survey_draft_check','human_approval','railwise.survey_draft_export'],ids=['trigger','check','approval','export'],labels=['接收待审草稿','检查来源与草稿','确认本次交付','导出审查稿']
  return {schemaVersion:1,id,name:`${draft.projectName} — 草稿复核与导出`,description:'检查所选成果和编辑草稿，确认后导出。此确认不替代专业签认。',workspace:draft.workspace,variables:{surveyDraftId:draft.id,engineering:true},nodes:ids.map((nid,index)=>({id:nid,type:types[index]!,label:labels[index]!,position:{x:index*230,y:120},bindings:{},config:index===2?{summary:'确认当前报告补充说明与图件草稿用于本次导出；不代表专业签认。'}:{},policy:{timeoutMs:120000,retryAttempts:0,retryBackoffMs:1000,errorBehavior:'fail',concurrencyLimit:1,resumable:true,breakpoint:false},disabled:false})),edges:ids.slice(1).map((nid,index)=>({id:`e${index}`,sourceNodeId:ids[index]!,sourcePortId:index===2?'approved':'output',targetNodeId:nid,targetPortId:'input',branch:'normal'}))}
}
function designDraft(id:string,model:ProfessionalReportModel):unknown {
  const display=professionalReportPresentation(model),table=display.tables.find(t=>t.rows.length)??display.tables[0],lines=[display.title,...(table?[table.title,...table.rows.slice(0,12).map(row=>table.columns.map(c=>`${c.label}${c.unit?` (${c.unit})`:''}: ${row[c.key]??'—'}`).join('   '))]:[]),'待审图件 · 成果摘要示意（非比例图）','基准与单位以所选原成果声明为准；请在交付前复核。']
  const now=Date.now()
  return {schemaVersion:'v1',id,revision:0,name:`${model.projectName} — 待审成果图`,format:'ppt169',pages:[{id:`page_${id}`,name:'成果摘要',width:1280,height:720,background:'FFFFFF',displayMode:'editable',elements:lines.map((text,index)=>({id:`text_${index}`,type:'text',x:48,y:36+index*40,w:1184,h:36,rotation:0,zIndex:index,text,fontSize:index===0?24:14,fontFamily:'Arial',fill:'1E293B',name:index===0?'成果标题':'专业摘要'}))}],assets:[],appliedCommands:[],createdAt:now,updatedAt:now}
}
