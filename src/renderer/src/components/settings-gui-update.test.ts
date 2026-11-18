import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GuiUpdateControl } from './settings-gui-update'

describe('software update settings', () => {
  it('keeps the downloaded package retryable and shows the installer error', () => {
    const markup = renderToStaticMarkup(createElement(GuiUpdateControl, {
      info: {
        ok: true,
        currentVersion: '0.5.6',
        latestVersion: '0.5.7',
        hasUpdate: true,
        releaseUrl: 'https://github.com/railwise-cn/railwise-ai/releases/tag/v0.5.7',
        channel: 'stable',
        downloaded: true
      },
      checking: false,
      downloading: false,
      installing: false,
      downloaded: true,
      progress: null,
      error: 'Windows 未能启动安装器，更新包已保留。',
      onCheck: async () => {},
      onDownload: async () => {},
      onInstall: async () => {},
      t: key => key
    }))

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('guiUpdateInstallFailedTitle')
    expect(markup).toContain('Windows 未能启动安装器，更新包已保留。')
    expect(markup).toContain('>guiUpdateInstall</button>')
    expect(markup).not.toContain('disabled=""')
    expect(markup).not.toContain('guiUpdateDownloadedDesc')
  })
})
