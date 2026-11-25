import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getOfficialMarketplaceCatalog } from './official-marketplace-catalog'
import {
  curateVideoShotcraftMirror,
  VIDEO_SHOTCRAFT_COMMIT,
  VIDEO_SHOTCRAFT_DISTRIBUTION_RECEIPT,
  VIDEO_SHOTCRAFT_DISTRIBUTION_VERSION
} from './video-shotcraft-distribution'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const item = getOfficialMarketplaceCatalog().find(candidate => candidate.id === 'video-shotcraft')!
const upstream = {
  'LICENSE': 'Apache License, Version 2.0\n',
  'NOTICE': 'Original upstream notice.\n',
  'README.md': '<img src="./assets/readme/sponsors/openlux.png" alt="OpenLux logo">\n',
  'README_CN.md': 'OpenLux 赞助说明。\n',
  'SKILL.md': '---\nname: video-shotcraft\n---\n\nOriginal skill body.\n',
  'template/package.json': '{"dependencies":{"remotion":"4.0.484"}}\n',
  'references/pipeline.md': 'Original workflow.\n',
  'assets/audio/ATTRIBUTION.md': 'Music attribution.\n',
  'assets/readme/sponsors/ATTRIBUTION.md': 'Trademark attribution.\nOpenLux logo and trademark are not covered by Apache-2.0.\n',
  'assets/readme/sponsors/openlux.png': 'Sponsor image filtered from the skill package.',
  'references/shots/ATTRIBUTION.md': 'Shot attribution.\n',
  'template/public/audio/ATTRIBUTION.md': 'SFX attribution.\n',
  'demos/animated-text.tsx': 'export const Frame = () => <div>Hello</div>\n',
  'assets/audio/bgm/raw-beat.mp3': 'Raw stock media',
  'assets/readme/sponsors/trademark.svg': '<svg/>',
  'demos/preview.mp4': 'Unreviewed preview',
  'gallery/index.html': 'Gallery with external media',
  'template/public/images/screenshot.png': 'Screenshot',
  'template/src/embedded.ts': `const url = 'data:image/png;base64,${'A'.repeat(512)}'\n`
}

async function stage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'railwise-video-shotcraft-curation-'))
  roots.push(root)
  for (const [path, value] of Object.entries(upstream)) {
    const target = join(root, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, value)
  }
  return root
}

describe('official Video Shotcraft distribution', () => {
  it('creates a separate release revision, preserving Apache material and recording excluded assets', async () => {
    const root = await stage()
    await curateVideoShotcraftMirror(item, root)
    const read = (path: keyof typeof upstream) => readFile(join(root, path), 'utf8')
    await expect(read('LICENSE')).resolves.toBe(upstream.LICENSE)
    await expect(read('NOTICE')).resolves.toBe(upstream.NOTICE)
    await expect(read('README.md')).resolves.toContain('openlux.png')
    await expect(read('README_CN.md')).resolves.toContain('OpenLux 赞助说明')
    await expect(readFile(join(root, 'assets/readme/sponsors/ATTRIBUTION.md'), 'utf8'))
      .resolves.toContain('OpenLux logo and trademark are not covered by Apache-2.0.')
    await expect(read('demos/animated-text.tsx')).resolves.toBe(upstream['demos/animated-text.tsx'])
    await expect(read('template/public/audio/ATTRIBUTION.md')).resolves.toBe(upstream['template/public/audio/ATTRIBUTION.md'])
    const skill = await read('SKILL.md')
    expect(skill.startsWith('---\nname: video-shotcraft\n---\n')).toBe(true)
    expect(skill).toContain('Original skill body.')
    expect(skill).toContain('licensed Remotion 4.0.484')
    const receipt = JSON.parse(await readFile(join(root, VIDEO_SHOTCRAFT_DISTRIBUTION_RECEIPT), 'utf8'))
    expect(receipt).toMatchObject({
      packageId: 'video-shotcraft',
      version: VIDEO_SHOTCRAFT_DISTRIBUTION_VERSION,
      upstream: { commit: VIDEO_SHOTCRAFT_COMMIT },
      modified: ['SKILL.md'],
      excludedFiles: [
        'assets/audio/bgm/raw-beat.mp3',
        'assets/readme/sponsors/openlux.png',
        'assets/readme/sponsors/trademark.svg',
        'demos/preview.mp4',
        'gallery/index.html',
        'template/public/images/screenshot.png',
        'template/src/embedded.ts'
      ]
    })
    for (const path of receipt.excludedFiles as string[]) {
      await expect(access(join(root, path))).rejects.toThrow()
    }
  })

  it('rejects an unreviewed distribution version before modifying the staged source', async () => {
    const root = await stage()
    await expect(curateVideoShotcraftMirror({ ...item, version: VIDEO_SHOTCRAFT_COMMIT }, root))
      .rejects.toThrow('does not match the reviewed package revision')
    await expect(readFile(join(root, 'assets/audio/bgm/raw-beat.mp3'), 'utf8')).resolves.toBe('Raw stock media')
  })
})
