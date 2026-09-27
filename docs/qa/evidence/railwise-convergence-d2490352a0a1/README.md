# d249035 公证候选复验

源码 `d2490352a0a12dbdff326b68483428ab3b1ed92e`，版本 0.5.0，隔离候选身份。GitHub Actions run 35433189815 的签名、公证票据、Gatekeeper、bundle 身份、版本和 loopback updater metadata 全部通过；仅保留 Actions artifact，未发布 Release、feed 或官网。

本机从认证 artifact 下载后核验 SHA-256 与 ZIP CRC，再安装 DMG。`package-evidence.json`、本地 `package.json` 和安装器记录均显示签名 0、stapler 0、Gatekeeper 0。包内 GSI/IN2 Runtime 与独立参考通过。

GUI 在同一安装包完成：合成 IN2 导入、校核、平差、误差椭圆显示、DOCX/PDF/XLSX 预览、待审查 manifest 以及五项只读复验；随后又完成真实 IN2 导入、校核、平差、三格式预览。真实 IN2 复验在包内重新显示了五项通过结果；原始界面截图含项目源信息，已移出仓库并保留在隔离候选证据目录，不作为公开证据。六份成果的输出文件与 manifest 哈希/大小逐项通过。所有成果仍是 `review pending` / 草案，复核、审核、批准和数字签名未实现。

该包产品代码来自 d249035；其后的键盘数据资产入口修正不在包内，需在当前 397d626 重新公证候选中复验。私有 HTTPS updater 往返尚未完成，不能进入发布门禁。
