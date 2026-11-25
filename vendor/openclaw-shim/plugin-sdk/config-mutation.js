import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function configPath() {
  return process.env.OPENCLAW_CONFIG_PATH || process.env.OPENCLAW_CONFIG || path.join(process.cwd(), 'openclaw.json')
}

let pendingMutation = Promise.resolve()

/** Minimal OpenClaw config mutation surface used by the bundled Weixin adapter. */
export function mutateConfigFile({ mutate }) {
  const operation = pendingMutation.then(async () => {
    const filePath = configPath()
    let config
    try {
      config = JSON.parse(await fs.readFile(filePath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      config = {}
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('OpenClaw config must contain a JSON object.')
    }

    const draft = structuredClone(config)
    await mutate(draft)
    const directory = path.dirname(filePath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    let mode = 0o600
    try {
      mode = (await fs.stat(filePath)).mode & 0o777
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', mode })
      await fs.rename(temporaryPath, filePath)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  })
  pendingMutation = operation.catch(() => undefined)
  return operation
}
