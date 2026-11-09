/** Ephemeral wake-up hints; durable task deliveries remain authoritative. */
export class SteeringQueue {
  private readonly buffers = new Map<string, Array<{text:string;inputId?:string}>>()
  private turnId: string | null = null
  setTurn(turnId:string|null):void { this.turnId=turnId; if(turnId&&!this.buffers.has(turnId)) this.buffers.set(turnId,[]) }
  enqueue(turnId:string,text:string):void { this.enqueueEntry(turnId,text) }
  enqueueEntry(turnId:string,text:string,inputId?:string):void { const trimmed=text.trim(); if(!trimmed)return; const buffer=this.buffers.get(turnId)??[]; buffer.push({text:trimmed,...(inputId?{inputId}:{})}); this.buffers.set(turnId,buffer) }
  drain(turnId=this.turnId):string[] { return this.drainEntries(turnId).map(entry=>entry.text) }
  drainEntries(turnId=this.turnId):Array<{text:string;inputId?:string}> { if(!turnId)return []; const pending=this.buffers.get(turnId)??[]; this.buffers.set(turnId,[]); return pending }
  peek(turnId=this.turnId):string[] { return turnId?(this.buffers.get(turnId)??[]).map(entry=>entry.text):[] }
  clear(turnId=this.turnId):void { if(turnId)this.buffers.delete(turnId); if(this.turnId===turnId)this.turnId=null }
}
