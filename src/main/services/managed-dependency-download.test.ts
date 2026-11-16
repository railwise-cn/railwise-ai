import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { dependencyDownloadUrls, downloadManagedDependency, managedDependency, managedPythonDownload } from './managed-dependency-download'

const bytes = Buffer.from('locked runtime bytes')
const asset = { ...managedDependency('uv-darwin-arm64'), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
const response = (body = bytes) => new Response(Uint8Array.from(body))

describe('managed dependency download', () => {
  it('uses the immutable company source first and verifies exact bytes', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) => response())
    expect(await downloadManagedDependency(asset, fetcher)).toEqual(bytes)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe(dependencyDownloadUrls(asset)[0])
  })

  it('uses the pinned upstream after mirror failure and verifies the same digest', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(response())
    expect(await downloadManagedDependency(asset, fetcher)).toEqual(bytes)
    expect(fetcher.mock.calls[1]?.[0]).toBe(asset.sourceUrl)
  })

  it('refuses modified bytes from either source', async () => {
    await expect(downloadManagedDependency(asset, vi.fn(async () => response(Buffer.alloc(bytes.length))))).rejects.toThrow(/SHA-256/)
    await expect(downloadManagedDependency(asset, vi.fn(async () => response(Buffer.alloc(bytes.length + 20))))).rejects.toThrow(/limit|large|size/i)
  })

  it('rejects unapproved redirects before trusting their bodies', async () => {
    const fetcher = vi.fn(async () => {
      const value = response()
      Object.defineProperty(value, 'url', { value: 'https://untrusted.example/archive' })
      return value
    })
    await expect(downloadManagedDependency(asset, fetcher)).rejects.toThrow(/approved HTTPS/)
  })

  it('binds all supported Python builds to their exact runtime digest', () => {
    for (const target of ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'linux-arm64', 'linux-x64']) {
      expect(managedPythonDownload(target).metadata.sha256).toBe(managedDependency(`python-${target}`).sha256)
    }
  })

  it('pins every BrowserSkill platform, source and license to immutable 0.5.0 downloads', () => {
    for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      const browser = managedDependency(`browser-skill-${target}`)
      expect(browser.version).toBe('0.5.0')
      expect(browser.sourceUrl).toContain('/Tencent/BrowserSkill/releases/download/cli-v0.5.0/')
      expect(browser.mirrorPath).toBe(`browser-skill/0.5.0/${browser.sha256}/${browser.name}`)
      expect(browser.license).toBe('MIT')
    }
    const source = managedDependency('browser-skill-source'), license = managedDependency('browser-skill-license')
    expect(source.sourceUrl).toBe('https://codeload.github.com/Tencent/BrowserSkill/zip/361da1d75798b99b358dfb434b8ce1921fb90d9e')
    expect(license.sourceUrl).toBe('https://raw.githubusercontent.com/Tencent/BrowserSkill/361da1d75798b99b358dfb434b8ce1921fb90d9e/LICENSE')
    for (const asset of [source, license]) {
      expect(asset.version).toBe('0.5.0')
      expect(asset.mirrorPath).toBe(`browser-skill/0.5.0/${asset.sha256}/${asset.name}`)
    }
  })
})
