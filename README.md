# AutoReel

从 NVIDIA 即时回放里按「击杀信息栏 OCR」自动剪出 Valorant 击杀集锦。

在对话里说一句「把最近一条回放剪一下」，就能拿到一段成片：每次击杀**前 3.5 秒到后 1.5 秒**，
按时间顺序拼好，同一场交战的连杀自动并成一段。工具卡片里有进度、逐条击杀（时间 + 击杀者 → 受害者）、
可拖动的播放器和「打开目录」；右侧栏面板可以改回放目录 / 输出目录 / 击杀前后秒数，然后直接「剪这条回放」。

产出固定是 `out/<素材名>/highlight_reel.mp4`。例如一条 120s 的 2K 录像（5 次击杀、4 段）→
成片 25.02s / 54.8 MB，端到端约 58s。实测数据见 [docs/BENCHMARKS.md](docs/BENCHMARKS.md)。

## 功能

- **自动认本机玩家**：按行首黄色头像框判定，换账号、换局都不用传 ID；
- **分辨率自适应**：1080p / 2K / 4K / 21:9 / 16:10 同一套 ROI 规则，不用配参数；
- **按屏幕占位重建 killfeed**：复活后再杀、跨回合重名、同屏多条都不会漏剪或重复剪；
- **连杀并段 + 段间不重叠**：同一场交战只出一段，成片里不会出现同一行击杀条两次；
- **默认不依赖 PowerShell**：JS 引擎编排，OCR 走自带的 `kfocr.exe`（Rust + rten）；
- **四种入口**：对话工具 `auto_reel`、工具卡片、右侧栏面板、命令行。

## 安装（DSH 插件）

推荐直接填 Release 地址（包内自带引擎、`kfocr.exe` 与 OCR 模型，约 27 MB）：

```
https://github.com/Yur1Chen/AutoReel/releases/latest/download/auto-reel.tgz
```

在 **插件** 页 →「添加插件」里填这个地址，或让 agent 用 `plugin_manager` 的 `install_bundle` 指向它。
装完刷新页面。也可以填本地 `.tgz` 的绝对路径，或者本地源码目录（开发用）。

> 从「源码目录（link）」换成 tgz / URL 安装前先提交或备份：pnpm 会顺着 junction 把仓库里的
> `plugin/` 清空（实测踩过，见 [docs/PUBLISHING.md](docs/PUBLISHING.md) 的「已知坑」）。

## 运行前需要

| 依赖 | 说明 |
|---|---|
| Windows | 只在这上面验证过（`explorer`、`%LOCALAPPDATA%`、`.exe`） |
| DeepSeek Harness | 插件宿主 |
| **ffmpeg 9** | `ffmpeg` / `ffprobe` 在 PATH 里；不随包分发，`winget install Gyan.FFmpeg` 即可 |
| Node | 由 DSH 自带，不用另装 |
| PowerShell 7 | 可选，只有 `engine: ps` 或 auto 回落时才用 |
| OCR 模型 | 分发包自带 `models/`；用源码目录安装时要在配置里给 `modelsDir` |

装好后访问 `/autoreel/api/health`，会逐项自检并点名缺哪一项。

## 用法

**对话**：说「把最近一条回放剪一下」。工具参数：`source`（省略=最新）、`localId`（默认 `auto`）、
`roi`（默认自适应）、`waitSeconds`（默认 45，超时返回作业 id，用 `job_output` 继续收）。

**面板**：右侧栏 → **AutoReel** 卡片 → 选回放 / 输出目录 / 前后秒数 →「剪这条回放」。
设置存到 `%LOCALAPPDATA%\AutoReel\settings.json`，即时生效。

**命令行**（不经插件，需要自己给模型目录）：

```powershell
$env:TACK_OCR_MODELS = 'D:\path\to\models'      # 需含 det.rten / rec.rten / ppocrv6_dict.txt

node scripts\highlight.mjs --source '<...>.DVR.mp4' --release
pwsh -File scripts\highlight.ps1 -Source '<...>.DVR.mp4' -Release
# 常用开关：--pre/--post（默认 3.5/1.5）、--models、--out、--roi、--keep-work、--reuse
```

完整参数（含 A/B 开关、批长、ROI 覆盖）见 [plugin/docs/DETAIL.md](plugin/docs/DETAIL.md) 和脚本头注释。

## 它是怎么工作的

1. **抽帧**：ffmpeg 一次解码 + `split=3`，按 2fps 裁出击杀条 3 个槽位（12.09s / 120s 素材）；
2. **OCR**：`kfocr --list` 分批识别（批长 60），同时顺手算「行首淡黄占比」判断本机玩家；
3. **重建**：按屏幕占位把 OCR 结果还原成击杀事件（复活、跨回合、同屏多条），再合并抖动变体；
4. **切片 + 拼接**：每段取「击杀前后」，段间钳制不重叠，x264 重编码后 concat。

原理与踩过的坑见 [docs/ENGINE-NOTES.md](docs/ENGINE-NOTES.md)，插件的接口与配置见
[docs/PLUGIN-PLAN.md](docs/PLUGIN-PLAN.md)。

## 仓库结构

```
kfocr/          OCR CLI（Rust，依赖 third_party/ 里的 Tack 快照）
third_party/    Tack 源码最小快照（tack-ocr + punct），双许可全文随目录
scripts/        引擎（highlight.mjs / highlight.ps1）、事件重建、合成用例、打包脚本
plugin/         DSH 插件：Host 工具 + 后台作业 + Client 卡片与面板
docs/           实测数据、实现笔记、插件方案、分发待办
out/            成片（不入库）
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | 实测数据：端到端耗时、抽帧 A/B、批处理拐点、测量环境的坑 |
| [docs/ENGINE-NOTES.md](docs/ENGINE-NOTES.md) | 本机 ID 推断、事件重建模型、修过的 6 个 bug、JS 移植的语义坑 |
| [docs/PLUGIN-PLAN.md](docs/PLUGIN-PLAN.md) | 插件方案、实施状态、接口与配置的实际实现 |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | 公开仓库与分发的待办、安装三条路的取舍 |
| [THIRD_PARTY.md](THIRD_PARTY.md) | 第三方组件与许可（Tack 快照、PP-OCRv6 Small 模型） |
| [SECURITY.md](SECURITY.md) | 本机 HTTP 路由的边界与数据流向 |

## 已知限制

- **Windows only**：依赖 `explorer /select`、`%LOCALAPPDATA%`、`.exe`；
- **OCR 依赖 Tack**：Tack 仍未完成、未公开，本仓库用 `third_party/` 里的快照，不会自动跟进上游；
- **槽位固定 3 个**：同屏出现第 4 条以上击杀时会看不到最新那条（扩到 5 格 OCR 次数 +67%）。

## 许可

本仓库代码为 MIT（见 [LICENSE](LICENSE)）。分发的产物还包含 Tack 源码快照（MIT OR Apache-2.0）
与 PP-OCRv6 Small 模型权重（Apache-2.0），详见 [THIRD_PARTY.md](THIRD_PARTY.md)。
