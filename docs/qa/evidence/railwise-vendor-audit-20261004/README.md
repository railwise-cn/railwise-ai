# RailWise Survey 公开厂商资料访问记录

日期：2026-10-04

这份记录只证明公开网页在本次复核时可访问，以及仓库已有实现对相关格式边界的回归覆盖。它不是厂商授权、互操作认证、SUC 对算或专业人员签认。

## 公开来源访问

以下响应由本机在 2026-10-04 访问并保存到临时目录后计算 SHA-256。原始网页未复制进安装包；仓库只保留来源 URL、访问时间和摘要哈希。

| 来源 | HTTP 结果 | 内容类型 | 本次内容 SHA-256 | 用途 |
| --- | --- | --- | --- | --- |
| [Carlson SurvCE RW5 File Format](https://update.carlsonsw.com/manuals/SurvCE/online/source/FileFormat.html) | 200 | text/html | `71484f68de3f7ddc3d6c61453026be7544fece81d0a0b7cbaf64b15319b9fead` | 核对 `OC.OP`、`TR/SS/BD/BR/FD/FR`、`LS.HI/HR` 和 `MO.UN` 字段边界 |
| [Trimble JobXML Schema 6.27](https://ww2.trimble.com/schema/JobXML/6_2/JobXMLSchema-6.27.xsd) | 200 | text/xml | `30e65680df92fb5c69ae4b683dee76d31e8db20c8e83e12ddc8c711b71c9f031` | 核对 JobXML 结构和公开单位声明；不据此启用平差 |
| [COSA 产品/格式说明](https://www.survey3d.com/changguicehui/changgui-kesha.html) | 200 | text/html | `bc50c4bbbceee96554b560e341a1ce4dfbc34100296fa70278d00d5646dcb935` | 核对 COSA 产品和格式线索；实际语义仍以受控解析器和来源证据为准 |
| [南方 NTS-591R10 手册](https://pm.southsurvey.com/static/uploads/downfiles/20250911/591R10%E6%B5%8B%E9%87%8F%E6%9C%BA%E5%99%A8%E4%BA%BA%E6%93%8D%E4%BD%9C%E6%89%8B%E5%86%8C-1757582889.pdf) | 本次连接失败 | application/pdf | 未取得 | 不把不可访问的手册写成已复核内容；南方 DAT 继续要求显式列映射并保持 archive-only |

访问失败或内容变化时，以上哈希不能作为当前页面内容的替代。下一次复核应重新访问并保留新的响应元数据。

## 当前源码证据映射

- COSA `.NET`：`kun/src/engineering/survey-cosa-net.test.ts` 已覆盖 16,384 字节行、10,000 条记录、8 MiB 来源、10,000 点坐标和超限阻断，且不返回部分三角形。
- COSA `.ou1`：`kun/src/engineering/survey-cosa-ou1.test.ts` 已覆盖 8 MiB 字符、100,000 行、16,384 字节行、10,000 点/观测和比较维度超限。
- 本地转换器：`kun/src/engineering/survey-converter.test.ts` 已覆盖哈希变化、无适配器保留原件、超大输出、符号链接、stdout/stderr 协议超限，以及 macOS 沙箱下的 timeout/cancel/子进程回收。macOS 进程测试受 `WORKWISE_TEST_MACOS_SURVEY_SANDBOX=1` 条件控制。

这些测试证明安全边界和失败处置，不证明每个厂商方言的生产互操作。COSA、Leica、Trimble、Carlson 和南方的授权、SUC 对算、真实仪器链和角色签认仍是外部门禁。

## 复核命令

```text
npm --prefix kun test -- src/engineering/survey-cosa-net.test.ts src/engineering/survey-cosa-ou1.test.ts src/engineering/survey-converter.test.ts
```

本记录不修改版本号、发布渠道、Git tag、官网或稳定更新源。
