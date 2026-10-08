# Survey 公共厂商资料与专业流程证据（2026-10-06）

这是一份来源复核记录，服务于 RailWise Survey 的专业流程设计和格式边界。它不是厂商授权、互操作认证、SUC 对算、规范符合性证明或专业人员签字。公开网页可以支持产品流程和字段语义研究；只有有权主体的书面许可、可复核原件及正式签认才能关闭外部门禁。

## 本次实际访问的公开资料

页面由同一 `ego-browser` 工作空间访问，并用 `curl -Lk` 保存响应元数据计算摘要哈希（只保留 URL、访问时间和哈希，不复制页面内容到安装包）：

| 来源 | 访问结果 | 内容 SHA-256 | 可核验事实 |
| --- | ---: | --- | --- |
| [COSA / 科傻产品说明](https://www.survey3d.com/changguicehui/changgui-kesha.html) | 200 text/html | `bc50c4bbbceee96554b560e341a1ce4dfbc34100296fa70278d00d5646dcb935` | 页面将 CosaGPS、CosaLEVEL、CosaCODAPS 分为 GPS、水平/沉降和地面控制网处理；描述观测概算、粗差探测、闭合差、投影、坐标转换、成果图形和多期沉降模型等能力，并列出输入仪器格式。页面品牌归属写为武汉大学测绘学院，但该网页不是授权书。 |
| [测量云：导线数据处理流程](http://help.celiangyun.com/knowledge/tsprocess23) | 200 text/html | `886529b10f658e6ba692b6f7494d03c97b82c48c477a26a15332b73e92200f5c` | 产品知识库明确八步流程：下载项目、下载外业数据、设置处理参数、设置平面已知点、可选高程控制点、平差解算、成果坐标变化分析、辅助功能（电子手簿、外业质量检查、原始数据查看、SUC/同类格式转换）。 |
| [测量云：输出平差文件](http://help.celiangyun.com/knowledge/outputadj) | 200 text/html | `7930719c3f417074dae0bf6a25399d57c8d926cc014af506cccfe2d6923536f1` | 产品团队页面说明可输出科傻、平差易、清华山维格式；页面归类为控制测量和轨道交通控制测量应用。它证明行业存在跨软件交付需求，不证明输出文件已通过目标厂商读取。 |
| [测量云产品团队知识库](http://help.celiangyun.com/author/celiangyun_pm) | 200 text/html | `e628401dbcd6a9c27eb4c6332d7fb46d68a80ad78af11d742b9cb92d0f12e51e` | 页面列出数据迁移、测站顺序、已知点、结果小数位、格式输出等实际操作主题，可作为传统软件工作流的公开产品线索。 |
| [Carlson SurvCE RW5 File Format](https://update.carlsonsw.com/manuals/SurvCE/online/source/FileFormat.html) | 200 text/html | `71484f68de3f7ddc3d6c61453026be7544fece81d0a0b7cbaf64b15319b9fead` | 官方格式说明用于核对 `OC.OP`、`TR/SS/BD/BR/FD/FR`、`LS.HI/HR`、`MO.UN`、`ZE/VA` 等记录和单位边界。 |
| [Trimble JobXML Schema 6.27](https://ww2.trimble.com/schema/JobXML/6_2/JobXMLSchema-6.27.xsd) | 200 text/xml | `30e65680df92fb5c69ae4b683dee76d31e8db20c8e83e12ddc8c711b71c9f031` | 官方 XSD 用于核对 JobXML 文档结构和公开单位说明；它不提供工程项目的独立基准、协方差或成果对算。 |
| [武汉大学知识产权信息服务中心](https://ipisc.whu.edu.cn/servicegoods) | 200 text/html | `a235a346869b9f413d3c89af12774a65c1b57b5fec064ab83459b5745bce4bab` | 作为可能的成果转化/知识产权咨询入口，不能被推定为 COSA 样本授权签字方。 |

## 对 RailWise Survey 的专业流程修订

公开传统产品资料共同显示，工程测量内业的可理解主线应当是：

1. 项目和外业资料入库，保留原始文件与期次；
2. 自动识别测量类型、站点/点号、观测记录和单位，检查测站顺序及数据完整性；
3. 明确平面已知点、可选高程控制点、坐标系和高程基准；
4. 进行概算、粗差/异常检查、拓扑和闭合差检查；
5. 由用户确认权、改正项和处理参数后解算；
6. 给出平差结果、精度评定、闭合/附合差、坐标变化或多期变形趋势；
7. 输出报告、图形和目标软件需要的交换成果，并保留原始数据、来源和结果绑定。

RailWise 的 AI 增益应放在每一步的识别、解释和复核准备上：自动提出资料类型和点/站角色，显示缺失基准或闭合问题的修复动作，将残差/异常定位到原始记录，生成含来源和单位的审查稿，并在用户确认后启动确定性计算。AI 不应猜列序、替换观测、把预警改成通过，或以模型回答代替正式专业签认。

## 外部门禁仍未关闭

- 没有取得 COSA/COSAWIN、测量云、Carlson、Trimble 或 SUC 厂商授权的私有原始工程样本、许可条款或同源结果对算书面确认；公开网页只支持格式/流程研究。
- 没有可验证身份的注册测量师/项目负责人签字、机构审批或规范符合性证书。模型不能代签，也不能把 AI review 标成真人签认。
- `/Volumes/MOVESPEED` 和 NAS 证据的历史只读记录仍受原路径授权、来源哈希和 `archive-only` 门禁约束；没有把原始文件复制到仓库或安装包。
- 因此 OpenSpec 的 `survey-professional-workflow 4.4`、工程交付中的真实厂商/专业生产验收门禁继续保持未完成；可完成的代码和 AI review 任务不能替代它们。

## 可复核命令与边界

```text
ego-browser nodejs -e '...同一 taskSpace(6) 访问上述 URL 并输出 snapshot...'
curl -Lk -A 'RailWise-Survey-evidence-review/0.5.2' -w '%{http_code} %{content_type}' <URL>
```

记录日期：2026-10-06（Asia/Singapore）。响应内容可能变化；后续复核必须重新访问并记录新摘要，不能把本记录的哈希当成永久页面快照。
