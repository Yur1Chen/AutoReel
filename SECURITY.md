# 安全说明

## 本插件会做什么

AutoReel 是一个 DSH 插件（bundle `@local/auto-reel`），在本机做三件事：

1. 用 `ffmpeg` 抽帧、切片、拼接；
2. 用 `kfocr.exe` 对击杀条做 OCR；
3. 在 DSH 的 Web 服务上注册几条本机 HTTP 路由（`/autoreel/*`），供工具卡片与右侧栏面板取数据。

## 本地 HTTP 路由

- 路由注册在 DSH 自己的 Web 服务上（默认只听回环地址）；
- 只读媒体路由（`/autoreel/media/...`）支持 `Range`，并把请求路径限制在配置的输出目录内，
  越界返回 403；
- **不做额外的用户鉴权**：任何能访问该 Web 服务的本机进程都能调用 `/autoreel/api/cut`
  等接口。这与 DSH 自身的信任模型一致（同一台机器、同一个用户），但如果你把 DSH 的端口
  暴露到局域网/公网，就同时暴露了这些接口。

## 文件与数据边界

- 源录像**只读**：不修改、不移动、不删除；
- 输出默认写在配置的输出目录（仓库 `out/` 或 `%LOCALAPPDATA%\AutoReel\out`）；
- 中间产物（抽帧 PNG、OCR 结果、切片）写在系统临时目录，跑完删除；`-KeepWork` 才保留；
- 设置保存在 `%LOCALAPPDATA%\AutoReel\settings.json`；
- 不联网、不上传任何数据。

## 第三方组件

见 [`THIRD_PARTY.md`](THIRD_PARTY.md)：Tack 源码快照（MIT OR Apache-2.0）、PP-OCRv6 Small
模型权重（Apache-2.0）。`kfocr.exe` 由这些代码编译，随包分发时一并附带许可与 NOTICE。

## 报告问题

如果发现安全问题，请通过仓库的 Issue 说明复现步骤；不要附上包含个人信息的录像或截图。
