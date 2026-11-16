// 必须是第一个 import:把旧品牌前缀的 localStorage 键拷贝到新前缀,
// 后面的 store 模块在 import 阶段就会读这些键。
import './lib/legacy-local-storage-migration'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import './styles/base-shell.css'
// Keep the compact activity mark's rendering rules after the legacy shell
// styles so the live logo is not clipped into jagged ghost strokes.
import './styles/work-logo.css'
import './styles/surfaces-write.css'
import './styles/markdown-code.css'
import './styles/write-editor.css'
import './styles/write-rich-editor.css'
import './styles/workbench-adaptive.css'
import './styles/settings-adaptive.css'
import App from './App'
import './i18n'
import { installWindowAppearanceBridge } from './lib/window-appearance'

document.documentElement.dataset.platform = window.workwise?.platform ?? 'unknown'
installWindowAppearanceBridge(window.workwise)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
