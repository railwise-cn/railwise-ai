# RailWise Survey 0.5.1 专业界面独立 AI 验收复核

日期：2026-10-02（Asia/Shanghai）  
复核角色：AI 模拟高级工程测量工程师、软件工程师与产品设计师  
范围：当前工作树源码与私有验收包 `/tmp/railwise-current-dist`。本记录不构成测量规范符合性、厂商互操作性或人工专业签认。

## 包身份与运行限制

- 私有包版本：0.5.1，arm64。
- ZIP SHA-256：`d9cff4c2141204bddb4b5137a6d940096d8a10945a8b5737e9400f24af093f3d`。
- DMG SHA-256：`02adf40626938b935c1ebd17f13cfb7da059a3cb785b31c016296c0d492815e1`。
- 私有包签名：adhoc，Team ID 未设置；未做公证。这是本机源码验收包，不能作为公开发布身份。
- 通过 `cua_repl` 绑定 `/tmp/railwise-current-dist/mac-arm64/RailWise AI.app` 和 `/Applications/RailWise AI.app` 均因 macOS LaunchServices/AppKit `-10005` 超时，未取得本轮新包截图或可交互 AX 树。
- 仓库中 `railwise-051-final-20aead04` 的截图来自历史候选，不能证明当前源码或当前私有包的视觉状态。

## 发现

### P1：测量结果页默认泄露内部算法和运行标识

`src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx:733-740` 直接显示 `strategyId`、`transformType`、`algorithmVersion` 和 `adjustment.run.id`。这些字段属于实现追溯信息，不是测量人员完成结果判断所必需的信息。默认结果卡片应只显示平差方法的专业名称、校核状态、闭合差、自由度、单位权中误差、点位精度和需要复核的问题；算法版本与运行 ID 放入“高级详情/来源与版本”。

### P1：变形结果默认显示算法版本和输入哈希

`src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx:753` 直接显示 `deformation.algorithmVersion` 和 `deformation.inputHash`。变形点表本身是专业内容，但哈希和实现版本应在高级追溯抽屉中展示，避免把技术协议混入工程结论。

### P1：证据定位提示直接显示网络 ID、修订号和源哈希

`src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx:763-766` 将 `networkId`、`networkRevision`、`adjustmentId`、`sourceSha256` 作为等宽文本渲染在工作区。用户应看到“已定位：平差结果 / 原始资料第 N 行 / 当前来源”，而不是内部身份与哈希；完整身份仍可放入高级详情。

### P1：成果页默认暴露清单 ID、路径和 SHA-256

`src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx:1254-1258` 直接渲染 `manifest.id`、`output.path` 和 `output.sha256`。交付页默认应显示文件名、格式、大小、生成时间、审查状态和警告；清单 ID、路径、哈希与来源链放入“高级追溯”。

### P2：高级计划区域仍使用开发协议文案

`src/renderer/src/components/engineering/EngineeringAiCommandCenter.tsx:359-361, 382-392` 在计划历史与展开详情中显示计划 ID、工具名称、参数 JSON、上下文哈希和绑定表达式。该区域已有折叠，但用户文案仍偏开发者。建议改为“处理步骤 / 输入与输出 / 可撤销性”，只有明确打开“技术追溯”后再显示原始协议。

### P2：专业化 AI 文本过滤范围有限

`engineering-professional-text.ts` 只处理 Survey AI 时间线 assistant 文本。它不会影响结果页、交付页、自由试算、统计诊断和高级模型组件中的内部字段；因此不能把 AI 时间线通过当作整个平台的专业表面验收通过。

## 已通过的源码级检查

- `EngineeringAiCommandCenter` 将时间线中的 `modelLabel` 置空，并使用 `engineeringProfessionalText` 过滤模型名、工具协议、上下文哈希及内部证据字段。
- `engineering-plan-transcript` 能将精确匹配的旧 Typed Plan 回执转换为“测量执行方案”，默认文本不包含计划编号、上下文哈希或 TaskRun。
- 现有 `engineering-professional-text.test.ts` 与 `engineering-plan-transcript.test.ts` 覆盖了上述过滤器的基本行为。

## 本轮定向测试结果

执行：`npm test -- --run src/renderer/src/components/engineering/engineering-professional-text.test.ts src/renderer/src/components/engineering/engineering-plan-transcript.test.ts`。

结果：1 个测试文件通过，`engineering-professional-text.test.ts` 仍有 2 项失败。第一项中 `precision.passed=true` 被通用布尔字段清理提前截断，输出为“精度检查=”；第二项测试期望把 Runtime 映射为“本地计算服务”，而当前实现将 Runtime 完全删除。两者需要统一到最终产品文案策略后重新运行，不能把当前定向测试标为通过。

## 结论与阻断

当前源码还不能宣称“界面只展示专业性相关内容”。AI 对话主时间线的脱敏方向正确，但测量结果、变形、证据定位和交付清单仍有 P1 级默认泄露点。应先把这些字段迁入统一高级追溯抽屉，再重新构建私有包并完成 1280×800、1440×900、窄窗、明暗主题和中英文的 computer-use 复验。由于本轮包启动被 `-10005` 阻断，未把视觉验收标记为通过。
