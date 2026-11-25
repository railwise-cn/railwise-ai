import os from 'node:os'
import path from 'node:path'

export function resolvePreferredOpenClawTmpDir() {
  return process.env.OPENCLAW_TMP_DIR?.trim() || path.join(os.tmpdir(), 'deepseek-gui-openclaw-shim')
}
