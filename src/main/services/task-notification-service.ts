import { readFile } from 'node:fs/promises'
import { atomicWriteFile, runSerialized } from './durable-file'
export type TaskNotificationPayload = {key:string;taskId:string;kind:'attention'|'artifact';title:string;body:string}
/** Claim before asking the OS to display; the durable task inbox is the recovery surface. */
export async function claimTaskNotification(path:string,key:string):Promise<boolean>{
  return runSerialized(`task-notification:${path}`,async()=>{
    let keys:Record<string,string>={}
    try{keys=JSON.parse(await readFile(path,'utf8')) as typeof keys}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
    if(Object.hasOwn(keys,key))return false
    keys[key]=new Date().toISOString()
    await atomicWriteFile(path,JSON.stringify(keys))
    return true
  })
}
