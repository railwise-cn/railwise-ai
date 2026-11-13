import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { downloadManagedDependency } from './managed-dependency-download'
import { ManagedBrowserSkillService } from './managed-browser-skill-service'

describe.runIf(process.env.RAILWISE_BROWSER_INSTALL_ACCEPTANCE === '1')('official BrowserSkill managed installation', () => {
  it('verifies the official archive, executable, isolated daemon and missing-extension diagnosis', async () => {
    const root = await mkdtemp(join(process.env.RAILWISE_BROWSER_ACCEPTANCE_ROOT || tmpdir(), 'browser-cli-live-'))
    const service = new ManagedBrowserSkillService({ root, homeDirectory: join(root, 'browser-state'),
      ...(process.env.RAILWISE_BROWSER_VERIFIED_ARCHIVE_ROOT ? { download: async (asset) => downloadManagedDependency(asset, async () => {
        const bytes = await readFile(join(process.env.RAILWISE_BROWSER_VERIFIED_ARCHIVE_ROOT!, asset.name))
        return new Response(bytes)
      }) } : {}),
      start: (path, args, env) => spawn(path, [...args, '--port', '0'], { env, shell: false, windowsHide: true, stdio: 'pipe' }) })
    try {
      const installed = await service.install()
      await writeFile(join(root, 'install-result.json'), JSON.stringify(installed, null, 2))
      expect(installed.ok, installed.message ?? installed.status.message).toBe(true)
      expect(installed.status.version).toBe('0.4.0')
      expect(installed.status.state).toBe('daemon_stopped')
      const connected = await service.connect()
      await writeFile(join(root, 'daemon-result.json'), JSON.stringify(connected, null, 2))
      expect(connected.ok, connected.status.message).toBe(true)
      expect(connected.status.state).toBe('needs_extension')
      expect(connected.status.daemonProtocolVersion).toBe('1.7')
      expect(connected.status.browsers).toEqual([])
      expect(await readFile(join(root, 'connection.json'), 'utf8')).toContain('0.4.0')
    } finally { service.dispose() }
  }, 300_000)
})
