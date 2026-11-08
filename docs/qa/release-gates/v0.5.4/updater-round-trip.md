# 0.5.4 更新往返

官方私有 updater run `42116660111` 在 macOS arm64 上完成真实 `0.5.3 → 0.5.4` 下载、Squirrel 安装、重启和用户数据保留校验。更新没有修改生产 feed 或 Stable 指针。

机器报告和原生报告按原始字节保存在同目录；验证器会再次核对报告、源码、artifact ID/digest 和目标 ZIP/ASAR 哈希。
