# 0.5.3 监测单位修订：独立 AI 源码复审

复审时间：2026-10-09T01:04:43.609367+00:00。结论：**当前四文件 diff 未发现遗留阻塞缺陷**；这是源码范围的独立 AI review，**不是最终包验收通过或发布批准**。未操作 CUA、正常 profile、标签、Release 或官网，未修改产品源码。

范围：HEAD `e5f212b19e6eb18867afa840da17e5ec1cacab5b` 之上的未提交四文件修订，diff SHA-256 `72dc50c96c68bea7b71e95ba3f4b75205ade26ac1ef3ef8a5385487c5105db9b`。此 HEAD 是源码基点，不是已安装包身份；公开版本目标为0.5.3，真实包版本/来源/安装哈希仍需后续观察。

## 结论依据

来源为6 mm、项目单位为m时，当前值/累计值/速率分别按6 mm、4 mm、2 mm/d呈现，保持来源数值和单位，不进行推断换算。aligned-m仍为0.006 m、0.004 m、0.002 m/d。各期单位冲突时可保留本期原值和其单位，变化与速率保持不可用，并用专业说明提示需要确认。旧记录缺单位明确显示“单位未记录”，不以项目当前单位重标历史数值。

初次复审发现缺unit/unitStatus的旧记录仍可显示绿色“正常”并计入正常摘要。协调代理接受该P1呈现问题后，当前 `monitoringThresholdStatus` 仅在已记录非空单位且状态aligned时呈现原阈值结论，其余为“未判定”；行badge、行色及摘要共用这一判据。专业说明保留旧“正常”声明为历史状态并要求复核，原分析对象和存储结论不改写。最终双语DOM回归实际检查了非绿色未判定badge、历史说明和原analysis仍normal。此发现已在本次复审范围解决，旧边界与初次测试结果保留为历史，不代表最终4文件的测试证据。

五项新增中英文文案键各唯一，插值一致，没有内部字段、工具ID或开发协议展示。数值组件对缺失/非有限值显示—，没有把缺失变化量变为0；速率单位使用来源单位/d。Runtime既有单位/期次合同与此表示一致：source-differs可进行来源单位内算术但不评定项目阈值；conflict不进行跨单位算术；重复时刻不除以0。修改限于显示与测试/文案，没有改变计算、批准、存储或迁移权限。

## 独立验证

- 最终 EngineeringWorkspaceView DOM：**74/74通过**，含en/zh的来源差异、aligned、conflict、缺单位旧记录及原状态保存。
- Runtime单位/时间/报告相邻合同：**22/22通过**（analysis-time 11、monitoring-report 7、numeric-cells 4），覆盖单位冲突、来源差异、时间间隔、旧分析/报告/清单保留。
- `git diff --check`通过；四个最终文件hash在独立DOM运行前后完全一致。

原始JSON测试结果、初次边界、最终边界与原diff均在本私有目录。没有运行全套发布检查；全套检查、PR/严格CI与新私有冻结由协调代理执行，不把74/22测试通过当作安装包验收。

## 精确文件绑定

| 文件 | SHA-256 |
| --- | --- |
| src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx | b0aae1dde4d04edd249a85dd10029a195812b1fc9ffca3c59988a1fe7d2a1725 |
| src/renderer/src/components/engineering/EngineeringWorkspaceView.dom.test.ts | bd11c78e226cf4f7ce8e1304d0c53c06648bb930f6f1163e64526685d2b0f12c |
| src/renderer/src/locales/en/common.json | 418bad96cddd647f6a7a31662c9b16668d23ebb92c325b6983117970c4ca5d2e |
| src/renderer/src/locales/zh/common.json | 5f897cecdc82aba67857c9f308062dca7aa85a4a901d1a04810b6e0f0d183756 |

## 实装仍需验证

真实包中的单位字样可读性、窄/宽窗、明暗主题、两语言、屏幕阅读器播报、来源差异/冲突/旧记录状态、原生三格式成果及同源数学读回仍待CUA。签名/公证、profile恢复、真实native updater和同包独立最终AI审查仍是另行必要门禁。

此AI review不能代表真实厂商/SUC互操作、规范符合、现场基准稳定性、真人专业签认或人类批准；也没有执行公开发布操作。
