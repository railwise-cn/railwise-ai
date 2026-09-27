import { describe, expect, it, vi } from 'vitest'
import {
  WORKWISE_PRODUCT_INTRO_URL,
  applicationMenuLabels,
  buildApplicationMenuTemplate,
  type ApplicationMenuActions
} from './application-menu'

function actions(): ApplicationMenuActions {
  return {
    send: vi.fn(),
    openExternal: vi.fn(),
    checkForUpdates: vi.fn(),
    showAbout: vi.fn(),
    openLogs: vi.fn(),
    quit: vi.fn()
  }
}

describe('application menu localization', () => {
  it('builds a fully localized Chinese macOS menu', () => {
    const template = buildApplicationMenuTemplate('zh', 'darwin', actions())
    const labels = template.map((item) => item.label)
    expect(labels).toEqual(['RailWise AI', '文件', '编辑', '显示', '窗口', '帮助'])

    const help = template.at(-1)?.submenu
    expect(Array.isArray(help) ? help.map((item) => item.label).filter(Boolean) : []).toEqual([
      '帮助中心',
      'RailWise AI 主页',
      '个人主页',
      '软件介绍',
      'GitHub 项目',
      '版本与下载',
      '检查更新…',
      '打开日志目录'
    ])
  })

  it('keeps the English template complete and links the product introduction', () => {
    const menuActions = actions()
    const template = buildApplicationMenuTemplate('en', 'win32', menuActions)
    expect(template.map((item) => item.label)).toEqual(['File', 'Edit', 'View', 'Window', 'Help'])

    const help = template.at(-1)?.submenu
    const intro = Array.isArray(help)
      ? help.find((item) => item.label === 'Software Introduction')
      : undefined
    intro?.click?.({} as never, {} as never, {} as never)
    expect(menuActions.openExternal).toHaveBeenCalledWith(WORKWISE_PRODUCT_INTRO_URL)
  })

  it('falls back to English for an unexpected persisted locale', () => {
    expect(applicationMenuLabels('de' as never).help.title).toBe('Help')
  })
})
