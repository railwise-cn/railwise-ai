# RailWise Survey 0.5.3 独立 AI review

日期：2026-10-07  
评审类型：**AI review**（工程测量实践、数值与成果语义、软件质量、产品设计的综合审查）  
评审结论：**未通过最终公开发布门禁**

本记录只表示 AI 对候选运行和已有证据的审查结果，不构成科傻 COSA 或其他厂商互操作证明、规范认证、真人签认、专业签字或生产验收。真实工程资料、厂商验证和有资质人员签认仍属于外部门禁，不能由 AI review 代替。

## 评审身份

- 整改分支：`codex/railwise-053-remediation`
- 评审源码提交：`5a9dc7d0e028d096adfe4652a68803330212c46f`
- 目标包版本：`0.5.3`
- DMG：`dist/WorkWise-0.5.3-mac-arm64.dmg`
- ZIP：`dist/WorkWise-0.5.3-mac-arm64.zip`
- Bundle ID：`com.wangjiawei508.workgpt`
- DMG SHA-256：`c94d92ef73a828734cbd33cbf6abd7d44be0d7071d5d5639a71a36f03ee7cddd`
- ZIP SHA-256：`e6a9ff05174d7602f27da8099b447355ee744181c9de83956798e8ef9f16f93f`
- 包内 `CFBundleShortVersionString`：`0.5.3`

## 包签名与安装状态

当前构建包的 `codesign` 结果为：

```text
Signature=adhoc
TeamIdentifier=not set
```

因此尚未满足 Apple Developer ID 签名、公证和 staple 要求。当前记录也没有证明从本次 `dist/mac-arm64` 包安装并启动后完成了完整 UI 验收；不能把候选运行身份与最终包身份合并解释。

本轮随后将 `dist/mac-arm64/RailWise AI.app` 复制到隔离目录并直接启动。窗口启动成功，版本和 Bundle 身份与上述包一致；切换到 Survey 后界面显示“Connect to the survey service to load jobs and deliverables”，任务与成果无法加载。该结果进一步确认：最终包实例尚未完成可用 Survey 服务的本地联通，不能据此验收导入、平差、结果或交付主流程。

## 已检查的候选运行

Computer Use 检查到的候选实例如下：

- App ID：`com.wangjiawei508.workgpt.candidate.head9527ec5f1bcb`
- 窗口：`RailWise AI`
- URL 根目录：`/private/tmp/railwise-053-candidate-9527ec5f/runtime/...`
- 候选实例不是当前 `dist/mac-arm64` 包的安装实例。

已归档的候选截图和无障碍树：

- [概览截图](screenshots/overview-en-dark-1280x840.png)
- [结果截图](screenshots/results-en-dark-cosa.jpg)
- [结果无障碍树](screenshots/results-en-dark-cosa.ax.txt)
- [交付截图](screenshots/deliver-en-dark-cosa.jpg)
- [交付无障碍树](screenshots/deliver-en-dark-cosa.ax.txt)

## UI 与产品审查结果

### 概览

通过候选运行检查。页面保留任务、当前来源、当前状态、最近结果和主要专业动作；没有 `TaskRun`、工具 ID、参数 JSON、`contextHash`、执行回执或代码调试提示。

### 处理

通过候选运行检查。导入、资料识别、网络类型、点/站/观测规模、基准与单位、网形、观测、点位和专业检查形成连续流程。需要处理区域使用测量语义，没有 `P0`、fixture、parser、内部接口或开发任务提示。

### 结果

通过候选运行检查。结果页展示计算状态、精度依据、闭合检查、残差、观测改正数、点位成果和专业复核边界。`Not evaluated` 用于标准符合性、独立闭合或人工签认等专业状态，属于正确的证据边界，不是开发状态。

### 交付

通过候选运行检查。交付页按审查稿、预览、DOCX/PDF/XLSX 导出组织；来源、审查记录和追溯信息在高级区域中保留，未要求普通用户理解 manifest、哈希或内部运行协议。

### AI 抽屉

通过候选运行检查。默认只显示 Survey AI、任务、资料/目标输入、导入/平差/刷新资料等专业操作。没有模型徽章、`Typed Plan`、`TaskRun`、工具参数、JSON 或内部哈希。AI 回答的展示层使用测量执行方案、资料依据、结果解释和需要复核等用户文案。

## 验收清单

| 检查项 | 状态 | 证据或缺口 |
| --- | --- | --- |
| 概览 / 处理 / 结果 / 交付四个工作视图 | 已通过（候选） | Computer Use 与归档截图 |
| AI 默认界面隐藏开发协议和代码信息 | 已通过（候选） | AI 抽屉和文案层检查 |
| 专业测量结果、复核边界和交付动作可见 | 已通过（候选） | 结果、交付无障碍树 |
| 当前 `dist` 0.5.3 包安装后验收 | 阻断 | 包窗口可启动，但 Survey 服务未联通；候选 App ID 与最终包 Bundle 不同 |
| Developer ID 签名 | 未通过 | 当前为 adhoc，未设置 TeamIdentifier |
| 公证与 staple | 未完成 | 没有有效公证回执 |
| 中文 / 英文矩阵 | 未完成 | 本轮仅有英文候选证据 |
| 明亮 / 深色主题矩阵 | 未完成 | 本轮仅检查深色候选证据 |
| 1280×800、1440×900、窄窗口 | 未完成 | 未形成完整窗口矩阵 |
| 键盘顺序、抽屉焦点恢复、live region | 未完成 | 未完成实测记录 |
| 失败、离线、过期、取消、重试和重新规划 | 未完成 | 未完成候选包状态测试 |
| 真实私有 updater round-trip | 未完成 | 未有与本包身份绑定的往返报告 |
| COSA/厂商互操作及专业签认 | 外部门禁 | AI review 不具备该证明能力 |

## 发布结论

0.5.3 当前不能作为公开发布依据。原因是最终安装包验收尚未完成，且包仍为 adhoc 签名、未完成公证/staple；中文/明亮/窄窗口、键盘可访问性、失败恢复和真实 updater round-trip 也没有形成完整证据。不得创建或移动公开版本标签，不得发布 GitHub Release，不得更新官网或稳定 feed。

本记录可以作为整改分支的独立 AI review 证据，但不能填充一个 `status=passed` 的公开发布 manifest。完成缺口后必须重新冻结包、安装同一包、重复验收并更新证据身份。
