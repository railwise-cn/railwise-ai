import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'

export const ArtifactProof = z.object({
  taskId: z.string(), artifactId: z.string(), absolutePath: z.string(), authorizedRoot: z.string(),
  executionGrantId: z.string(), turnId: z.string(), operationId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()

export type TaskArtifactReader = (path: string, method: 'GET') => Promise<{ ok: boolean; status: number; body: string }>

export async function readVerifiedTaskArtifact(request: { taskId: string; artifactId: string }, runtimeRequest: TaskArtifactReader, maxBytes = 200 * 1024 * 1024): Promise<{ proof: z.infer<typeof ArtifactProof>; bytes: Buffer }> {
  const response = await runtimeRequest(`/v1/tasks/${encodeURIComponent(request.taskId)}/artifacts/${encodeURIComponent(request.artifactId)}/proof`, 'GET')
  if (!response.ok) throw new Error('成果已变化或授权证据无法核验，请在任务中重新审阅。')
  const proof = ArtifactProof.parse(JSON.parse(response.body))
  if (proof.taskId !== request.taskId || proof.artifactId !== request.artifactId || !isAbsolute(proof.absolutePath) || !isAbsolute(proof.authorizedRoot)) throw new Error('成果证据与所选文件不一致。')
  const [path, root] = await Promise.all([realpath(proof.absolutePath), realpath(proof.authorizedRoot)])
  if (path !== proof.absolutePath || root !== proof.authorizedRoot) throw new Error('成果路径已变化。')
  const relativePath = relative(root, path)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error('成果路径超出已授权范围。')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maxBytes) throw new Error('成果不是可预览的普通文件，或超过读取大小上限。')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length
      if (size > maxBytes) throw new Error('成果超过读取大小上限。')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks, size)
    const after = await handle.stat()
    if (bytes.byteLength > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || createHash('sha256').update(bytes).digest('hex') !== proof.sha256 || await realpath(path) !== path) throw new Error('成果内容在验证后发生变化，请重新审阅。')
    return { proof, bytes }
  } finally { await handle.close() }
}

export async function openVerifiedTaskArtifact(
  request: { taskId: string; artifactId: string },
  dependencies: {
    runtimeRequest: (path: string, method: 'GET') => Promise<{ ok: boolean; status: number; body: string }>
    openPath: (path: string) => Promise<string>
  }
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { proof } = await readVerifiedTaskArtifact(request, dependencies.runtimeRequest)
    const error = await dependencies.openPath(proof.absolutePath)
    if (error) throw new Error(error)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
