import { app } from 'electron'

/**
 * 项目对外展示的产品名,需要和:
 *   - package.json#productName
 *   - electron-builder.cjs#productName
 *   - tray 菜单和 tooltip
 * 保持一致。Windows 任务栏 / 系统托盘 / 通知中心看到的应用名都来自
 * 这条字符串(在打包产物里还会被写进 VERSIONINFO)。
 *
 * The historical Windows upgrade identifier remains unchanged so existing
 * installations can upgrade in place. It is a platform compatibility value,
 * not a product name and is allowlisted by the brand-boundary check.
 */
export const APP_PRODUCT_NAME = 'RailWise AI'
export const CANDIDATE_APP_PRODUCT_NAME = 'RailWise AI Candidate'

/**
 * 在 main 进程最早期调用,把 app 的对外名称设好。
 * `app.setName()` 会覆盖 `app.getName()` 的返回值(优先于 package.json#name
 * 字段),并影响 BrowserWindow 默认 title、通知、托盘等所有用 `app.getName()`
 * 拿名字的地方。要尽早调用,免得启动早期就拿走了旧值。
 *
 * Windows 平台专属的 `app.setAppUserModelId()` 不在这里调 —— 它是 win32
 * 专用的,放在 main/index.ts 的 win32 分支里更直观。
 */
export function configureAppIdentity(env: NodeJS.ProcessEnv = process.env): void {
  app.setName(env.WORKWISE_CANDIDATE === '1' ? CANDIDATE_APP_PRODUCT_NAME : APP_PRODUCT_NAME)
}
