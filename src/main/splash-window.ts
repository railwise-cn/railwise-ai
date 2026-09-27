import brand from '../shared/product-brand.json'
import { BrowserWindow } from 'electron'
import type { WindowAppearanceV1 } from '../shared/window-appearance'
import { applyWindowMaterial, windowMaterialOptions } from './window-appearance'

export type SplashProgress = {
  progress: number
  label: string
}

export const SPLASH_MIN_VISIBLE_MS = 1_200

export function splashRemainingVisibleMs(
  openedAt: number,
  now: number,
  minimumVisibleMs = SPLASH_MIN_VISIBLE_MS
): number {
  if (!Number.isFinite(openedAt) || openedAt <= 0) return 0
  return Math.max(0, minimumVisibleMs - Math.max(0, now - openedAt))
}

type SplashWindowOptions = {
  appearance: WindowAppearanceV1
  dark: boolean
  version: string
  locale: 'zh' | 'en'
  logoDataUrl?: string
  logoDarkDataUrl?: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function splashProgressLabel(
  locale: 'zh' | 'en',
  phase: 'workspace' | 'services' | 'extensions' | 'interface' | 'ready'
): string {
  const labels = locale === 'zh'
    ? {
        workspace: '正在准备工作区',
        services: '正在启动本地服务',
        extensions: '正在载入扩展',
        interface: '正在打开工作台',
        ready: '已就绪'
      }
    : {
        workspace: 'Preparing workspace',
        services: 'Starting local services',
        extensions: 'Loading extensions',
        interface: 'Opening workbench',
        ready: 'Ready'
      }
  return labels[phase]
}

export function buildSplashHtml(options: SplashWindowOptions, initial: SplashProgress): string {
  const progress = clampProgress(initial.progress)
  const hasDarkLogo = options.logoDarkDataUrl?.startsWith('data:image/')
  const logo = options.logoDataUrl?.startsWith('data:image/')
    ? `<img class="logo${hasDarkLogo ? ' logo-light' : ''}" src="${escapeHtml(options.logoDataUrl)}" alt="" />${hasDarkLogo ? `<img class="logo logo-dark" src="${escapeHtml(options.logoDarkDataUrl!)}" alt="" />` : ''}`
    : '<div class="logo-fallback" aria-hidden="true">R</div>'
  const theme = options.dark ? 'dark' : 'light'
  const material = escapeHtml(options.appearance.material)
  const lang = options.locale === 'zh' ? 'zh-CN' : 'en'

  return `<!doctype html>
<html lang="${lang}" data-theme="${theme}" data-material="${material}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
  <meta name="color-scheme" content="light dark" />
  <title>${brand.platform}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body {
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      color: #20242b;
      user-select: none;
    }
    .splash {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 28px 34px 24px;
      border: 1px solid rgba(255, 255, 255, 0.54);
      border-radius: 14px;
      background: rgba(247, 249, 252, 0.78);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.62), 0 22px 64px rgba(15, 23, 42, 0.2);
    }
    html[data-material="solid"] .splash { background: #f5f7fa; }
    html[data-theme="dark"] body { color: #f4f4f5; }
    html[data-theme="dark"] .splash {
      border-color: rgba(255, 255, 255, 0.12);
      background: rgba(20, 20, 22, 0.78);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 24px 72px rgba(0, 0, 0, 0.44);
    }
    html[data-theme="dark"][data-material="solid"] .splash { background: #151517; }
    .logo { width: 112px; height: 64px; flex-shrink: 0; object-fit: contain; }
    .logo-dark { display: none; }
    html[data-theme="dark"] .logo-dark { display: block; }
    html[data-theme="dark"] .logo-light { display: none; }
    .logo-fallback {
      display: grid;
      width: 96px;
      height: 96px;
      place-items: center;
      border-radius: 8px;
      background: #0088ff;
      color: white;
      font-size: 24px;
      font-weight: 650;
    }
    .brand { margin-top: 12px; font-size: 22px; font-weight: 650; letter-spacing: 0; }
    .version { margin-top: 3px; color: rgba(67, 76, 91, 0.68); font-size: 11px; }
    html[data-theme="dark"] .version { color: rgba(226, 232, 240, 0.52); }
    .progress { width: 100%; margin-top: 24px; }
    .track { height: 3px; overflow: hidden; border-radius: 2px; background: rgba(100, 116, 139, 0.18); }
    .bar { width: ${progress * 100}%; height: 100%; border-radius: inherit; background: #1683e8; transition: width 180ms ease; }
    .status { min-height: 17px; margin-top: 9px; color: rgba(67, 76, 91, 0.72); font-size: 11px; text-align: center; }
    html[data-theme="dark"] .track { background: rgba(255, 255, 255, 0.13); }
    html[data-theme="dark"] .bar { background: #4aa8ff; }
    html[data-theme="dark"] .status { color: rgba(226, 232, 240, 0.6); }
    @media (prefers-reduced-motion: reduce) { .bar { transition: none; } }
    @media (prefers-reduced-transparency: reduce), (forced-colors: active) {
      .splash { background: #f5f7fa; box-shadow: none; }
      html[data-theme="dark"] .splash { background: #151517; }
    }
  </style>
</head>
<body>
  <main class="splash">
    ${logo}
    <div class="brand">${brand.platform}</div>
    <div class="version">${escapeHtml(options.version)}</div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress * 100)}">
      <div class="track"><div class="bar"></div></div>
      <div class="status" aria-live="polite">${escapeHtml(initial.label)}</div>
    </div>
  </main>
  <script>
    window.__workwiseSplashUpdate = function (next) {
      var progress = Math.max(0, Math.min(1, Number(next.progress) || 0));
      document.querySelector('.bar').style.width = String(progress * 100) + '%';
      document.querySelector('.status').textContent = String(next.label || '');
      document.querySelector('.progress').setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    };
  </script>
</body>
</html>`
}

export class SplashWindowController {
  readonly browserWindow: BrowserWindow
  private loaded = false
  private closed = false
  private current: SplashProgress

  constructor(private readonly options: SplashWindowOptions, initial: SplashProgress) {
    this.current = { ...initial, progress: clampProgress(initial.progress) }
    this.browserWindow = new BrowserWindow({
      width: 360,
      height: 248,
      frame: false,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      roundedCorners: true,
      transparent: options.appearance.transparencyEnabled,
      ...windowMaterialOptions(options.appearance, options.dark),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    this.browserWindow.once('ready-to-show', () => {
      if (!this.closed) this.browserWindow.show()
    })
    this.browserWindow.webContents.once('did-finish-load', () => {
      this.loaded = true
      this.flushProgress()
    })
    this.browserWindow.on('closed', () => {
      this.closed = true
    })

    const html = buildSplashHtml(options, this.current)
    void this.browserWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
  }

  update(progress: SplashProgress): void {
    if (this.closed) return
    this.current = { ...progress, progress: clampProgress(progress.progress) }
    this.flushProgress()
  }

  applyAppearance(appearance: WindowAppearanceV1, dark: boolean): void {
    if (this.closed || this.browserWindow.isDestroyed()) return
    applyWindowMaterial(this.browserWindow, process.platform, appearance, dark)
    if (this.loaded && !this.browserWindow.webContents.isDestroyed()) {
      void this.browserWindow.webContents
        .executeJavaScript(
          `document.documentElement.dataset.material=${JSON.stringify(appearance.material)};document.documentElement.dataset.theme=${JSON.stringify(dark ? 'dark' : 'light')}`,
          true
        )
        .catch(() => undefined)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (!this.browserWindow.isDestroyed()) this.browserWindow.close()
  }

  private flushProgress(): void {
    if (!this.loaded || this.closed || this.browserWindow.webContents.isDestroyed()) return
    const payload = JSON.stringify(this.current)
    void this.browserWindow.webContents
      .executeJavaScript(`window.__workwiseSplashUpdate(${payload})`, true)
      .catch(() => undefined)
  }
}

export function createSplashWindow(options: SplashWindowOptions): SplashWindowController {
  return new SplashWindowController(options, {
    progress: 0.18,
    label: splashProgressLabel(options.locale, 'workspace')
  })
}
