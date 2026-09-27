import brand from '../shared/product-brand.json'
import type { MenuItemConstructorOptions } from 'electron'
import type { AppSettingsV1 } from '../shared/app-settings'
import type { ApplicationMenuAction } from '../shared/workwise-api'

export const WORKWISE_GITHUB_URL = 'https://github.com/railwise-cn/railwise-ai'
export const WORKWISE_PRODUCT_URL = 'https://www.railwise.cn/products/workwise/'
export const WORKWISE_AUTHOR_URL = 'https://github.com/wangjiawei508'
export const WORKWISE_PRODUCT_INTRO_URL =
  'https://github.com/railwise-cn/railwise-ai/blob/main/docs/product-introduction.zh-CN.md'
export const WORKWISE_RELEASES_URL = `${WORKWISE_GITHUB_URL}/releases`

export type ApplicationMenuActions = {
  send: (action: ApplicationMenuAction) => void
  openExternal: (url: string) => void
  checkForUpdates: () => void
  showAbout: () => void
  openLogs: () => void
  quit: () => void
}

type MenuLabels = {
  app: {
    about: string
    services: string
    hide: string
    hideOthers: string
    showAll: string
    quit: string
  }
  file: {
    title: string
    newChat: string
    chooseWorkspace: string
    settings: string
    close: string
  }
  edit: {
    title: string
    undo: string
    redo: string
    cut: string
    copy: string
    paste: string
    pasteAndMatchStyle: string
    delete: string
    selectAll: string
  }
  view: {
    title: string
    reload: string
    forceReload: string
    devTools: string
    actualSize: string
    zoomIn: string
    zoomOut: string
    fullScreen: string
  }
  window: {
    title: string
    minimize: string
    zoom: string
    front: string
  }
  help: {
    title: string
    center: string
    productHome: string
    authorHome: string
    productIntro: string
    github: string
    releases: string
    checkUpdates: string
    logs: string
  }
}

const LABELS: Record<AppSettingsV1['locale'], MenuLabels> = {
  zh: {
    app: {
      about: `关于 ${brand.platform}`,
      services: '服务',
      hide: `隐藏 ${brand.platform}`,
      hideOthers: '隐藏其他',
      showAll: '全部显示',
      quit: `退出 ${brand.platform}`
    },
    file: {
      title: '文件',
      newChat: '新建会话',
      chooseWorkspace: '选择工作区…',
      settings: '设置…',
      close: '关闭窗口'
    },
    edit: {
      title: '编辑',
      undo: '撤销',
      redo: '重做',
      cut: '剪切',
      copy: '复制',
      paste: '粘贴',
      pasteAndMatchStyle: '粘贴并匹配样式',
      delete: '删除',
      selectAll: '全选'
    },
    view: {
      title: '显示',
      reload: '重新加载',
      forceReload: '强制重新加载',
      devTools: '开发者工具',
      actualSize: '实际大小',
      zoomIn: '放大',
      zoomOut: '缩小',
      fullScreen: '进入全屏幕'
    },
    window: {
      title: '窗口',
      minimize: '最小化',
      zoom: '缩放',
      front: '前置全部窗口'
    },
    help: {
      title: '帮助',
      center: '帮助中心',
      productHome: `${brand.platform} 主页`,
      authorHome: '个人主页',
      productIntro: '软件介绍',
      github: 'GitHub 项目',
      releases: '版本与下载',
      checkUpdates: '检查更新…',
      logs: '打开日志目录'
    }
  },
  en: {
    app: {
      about: `About ${brand.platform}`,
      services: 'Services',
      hide: `Hide ${brand.platform}`,
      hideOthers: 'Hide Others',
      showAll: 'Show All',
      quit: `Quit ${brand.platform}`
    },
    file: {
      title: 'File',
      newChat: 'New Chat',
      chooseWorkspace: 'Choose Workspace…',
      settings: 'Settings…',
      close: 'Close Window'
    },
    edit: {
      title: 'Edit',
      undo: 'Undo',
      redo: 'Redo',
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
      pasteAndMatchStyle: 'Paste and Match Style',
      delete: 'Delete',
      selectAll: 'Select All'
    },
    view: {
      title: 'View',
      reload: 'Reload',
      forceReload: 'Force Reload',
      devTools: 'Developer Tools',
      actualSize: 'Actual Size',
      zoomIn: 'Zoom In',
      zoomOut: 'Zoom Out',
      fullScreen: 'Toggle Full Screen'
    },
    window: {
      title: 'Window',
      minimize: 'Minimize',
      zoom: 'Zoom',
      front: 'Bring All to Front'
    },
    help: {
      title: 'Help',
      center: 'Help Center',
      productHome: `${brand.platform} Homepage`,
      authorHome: 'Personal Homepage',
      productIntro: 'Software Introduction',
      github: 'GitHub Project',
      releases: 'Releases & Downloads',
      checkUpdates: 'Check for Updates…',
      logs: 'Open Logs Folder'
    }
  }
}

export function applicationMenuLabels(locale: AppSettingsV1['locale']): MenuLabels {
  return LABELS[locale] ?? LABELS.en
}

export function buildApplicationMenuTemplate(
  locale: AppSettingsV1['locale'],
  platform: NodeJS.Platform,
  actions: ApplicationMenuActions
): MenuItemConstructorOptions[] {
  const l = applicationMenuLabels(locale)
  const open = (url: string) => (): void => actions.openExternal(url)
  const send = (action: ApplicationMenuAction) => (): void => actions.send(action)
  const template: MenuItemConstructorOptions[] = []

  if (platform === 'darwin') {
    template.push({
      label: brand.platform,
      submenu: [
        { label: l.app.about, click: actions.showAbout },
        { label: l.help.checkUpdates, click: actions.checkForUpdates },
        { type: 'separator' },
        { label: l.app.services, role: 'services' },
        { type: 'separator' },
        { label: l.app.hide, role: 'hide' },
        { label: l.app.hideOthers, role: 'hideOthers' },
        { label: l.app.showAll, role: 'unhide' },
        { type: 'separator' },
        { label: l.app.quit, accelerator: 'Command+Q', click: actions.quit }
      ]
    })
  }

  template.push(
    {
      label: l.file.title,
      submenu: [
        { label: l.file.newChat, accelerator: 'CmdOrCtrl+N', click: send('new-chat') },
        { label: l.file.chooseWorkspace, accelerator: 'CmdOrCtrl+O', click: send('choose-workspace') },
        { type: 'separator' },
        { label: l.file.settings, accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { label: l.file.close, role: 'close' }
      ]
    },
    {
      label: l.edit.title,
      submenu: [
        { label: l.edit.undo, role: 'undo' },
        { label: l.edit.redo, role: 'redo' },
        { type: 'separator' },
        { label: l.edit.cut, role: 'cut' },
        { label: l.edit.copy, role: 'copy' },
        { label: l.edit.paste, role: 'paste' },
        { label: l.edit.pasteAndMatchStyle, role: 'pasteAndMatchStyle' },
        { label: l.edit.delete, role: 'delete' },
        { label: l.edit.selectAll, role: 'selectAll' }
      ]
    },
    {
      label: l.view.title,
      submenu: [
        { label: l.view.reload, role: 'reload' },
        { label: l.view.forceReload, role: 'forceReload' },
        { label: l.view.devTools, role: 'toggleDevTools' },
        { type: 'separator' },
        { label: l.view.actualSize, role: 'resetZoom' },
        { label: l.view.zoomIn, role: 'zoomIn' },
        { label: l.view.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: l.view.fullScreen, role: 'togglefullscreen' }
      ]
    },
    {
      label: l.window.title,
      submenu: [
        { label: l.window.minimize, role: 'minimize' },
        { label: l.window.zoom, role: 'zoom' },
        ...(platform === 'darwin'
          ? [{ type: 'separator' as const }, { label: l.window.front, role: 'front' as const }]
          : [])
      ]
    },
    {
      label: l.help.title,
      submenu: [
        { label: l.help.center, click: send('help-center') },
        { label: l.help.productHome, click: open(WORKWISE_PRODUCT_URL) },
        { label: l.help.authorHome, click: open(WORKWISE_AUTHOR_URL) },
        { label: l.help.productIntro, click: open(WORKWISE_PRODUCT_INTRO_URL) },
        { type: 'separator' },
        { label: l.help.github, click: open(WORKWISE_GITHUB_URL) },
        { label: l.help.releases, click: open(WORKWISE_RELEASES_URL) },
        { label: l.help.checkUpdates, click: actions.checkForUpdates },
        { type: 'separator' },
        { label: l.help.logs, click: actions.openLogs }
      ]
    }
  )

  return template
}
