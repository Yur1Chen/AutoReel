# AutoReel

从 NVIDIA 即时回放里按「击杀信息栏 OCR」自动剪出击杀集锦。

在对话里说一句「把最近一条回放剪一下」，几秒到一分钟后拿到一段成片：**击杀前 3.5s 到击杀后
1.5s** 的片段按时间顺序拼好，同一场交战的连杀会自动并成一段。工具卡片里能看到进度条、逐条击杀
（时间 / 击杀者 → 受害者）和可拖动的播放器，还有一个「打开目录」按钮；右侧栏面板可以把回放目录、
输出目录、击杀前后秒数改掉后直接「剪这条回放」。

实际产出就是 `out/<素材名>/highlight_reel.mp4` —— 例如一条 120s 的 2K 录像（5 次击杀、4 段），
成片 25.02s / 54.8 MB。

方案来源：`HIGHLIGHT-KILLFEED-OCR-2026-11-07.md`（旧工作区 `docs/`）。本仓库是它在
`D:\AIworks\AutoReel` 下的落地版本，已端到端跑通并复现文档结论。

> **命名**：产品名是 **AutoReel** —— 插件包 `@local/auto-reel`、工具 `auto_reel`、
> 路由 `/autoreel/*`，物理目录 `D:\AIworks\AutoReel`（2026-11-18 由 `HighlightCut` 改名）。
>
> 改名只动文件夹是不够的，DSH 那边还有 3 处指向旧路径——**2026-11-18 已全部改完并重启生效**：
> ① profile 的 `package.json` 里 `"link:…/plugin"` 与 `node_modules\@local\auto-reel` 这个 junction
> （已重指到 `D:\AIworks\AutoReel\plugin`，`pnpm-lock.yaml` 与 `node_modules\.pnpm\lock.yaml` 一并更新）；
> ② `%LOCALAPPDATA%\AutoReel\settings.json` 的 `outputDir`（已改为 `D:\AIworks\AutoReel\out`）；
> ③ `%DSH_HOME%\storages\workspace.json` 里该工作区的 `path`（已是 `D:\AIworks\AutoReel`，`title` = `AutoReel`）。
>
> 改完必须重启 DSH（Host 半）并刷新页面（Client 半），否则工具和面板仍按旧路径加载。

## 目录

```
AutoReel/
├─ kfocr/                   OCR CLI（依赖 third_party/ 里的 Tack 快照）
├─ third_party/             Tack 源码最小快照（tack-ocr + punct），双许可全文随目录
├─ THIRD_PARTY.md           第三方组件与许可登记（代码快照 / 模型 SHA256 / 依赖）
├─ scripts/highlight.ps1    全流程：抽帧 → OCR → 重建 → 切片 → 拼接（-Machine 出机器事件）
├─ scripts/lib/events.ps1   击杀事件重建（屏幕占位模型，含复活/跨回合判定）
├─ scripts/test-events.ps1  上述逻辑的合成用例
├─ scripts/highlight.mjs    ↑ 的 JS 版全流程（不依赖 pwsh；--machine 出同样的机器事件）
├─ scripts/lib/events.mjs   击杀事件重建（JS，与 events.ps1 逐函数对应）
├─ scripts/lib/{proc,roi,round}.mjs  起进程 / ROI 换算 / PowerShell 取整语义
├─ scripts/lib/marker-ps.ps1 「行首黄框」采样的 PS 实现（test-marker 的对照基准）
├─ scripts/test-events.mjs  合成用例（JS 版，含 ROI 取整）
├─ scripts/test-parity.mjs  PS vs JS 金样比对（逐条比 localId / kills / segments / 成片 SHA256）
├─ scripts/test-marker.mjs  「行首黄框」采样的双实现对照（System.Drawing vs kfocr --marker）
├─ scripts/test-plugin.mjs  插件引擎适配自测（参数映射 / --spawn 真跑一次）
├─ scripts/test-host.mjs    Host 设置接口自测（假 ctx，不起引擎）
├─ scripts/test-client.mjs  客户端注册自测（tab / 面板 / 卡片）
├─ scripts/build-plugin.ps1 打包成可分发的 dist/auto-reel-<version>.tgz
├─ plugin/                  DSH 插件（Host 工具 + 后台作业 + Client 工具卡片）
│  └─ docs/DETAIL.md        插件配置项、限制与事件格式
├─ docs/PLUGIN-PLAN.md      插件方案与实施状态
├─ SECURITY.md              本地 HTTP 路由的边界与数据流向
├─ .github/workflows/ci.yml CI：JS 用例 + kfocr 构建
├─ docs/PUBLISHING.md       公开仓库与分发的待办清单（含 Tack 依赖的处理方案）
├─ dist/                    分发产物（auto-reel-<version>.tgz，构建时生成）
└─ out/<素材名>/
   └─ highlight_reel.mp4      ← 只有成片
```

**输出目录里只有成片**，一个素材一个文件夹，名字取自录像（去掉 `Valorant ` 与 `.DVR`）：

```
out/2026.11.11 - 23.21.53.04/highlight_reel.mp4
```

抽帧、OCR 结果、切片、`kills.json` 这些中间产物默认写到系统临时目录并在跑完后删除，
不再堆在 `out/` 里。需要复用或排查时加 `-KeepWork`（见下）。

## 依赖

- ffmpeg 9.0（在 PATH 中；`-/filter_complex` 可用）
- Rust 1.97.1 / cargo（构建 `kfocr`；JSON 化引擎用到 `--marker`，需要重新构建）
  - `tack-ocr` / `tack-core` 来自作者自研的 Tack（尚未完成、未公开），仓库里
    [`third_party/`](third_party/README.md) 放了一份**最小快照**（`tack-ocr` 全量 + 19 KB 的
    `punct` 模块，约 200 KB），所以 clone 下来可直接 `cargo build`；上游更新时按
    [`third_party/README.md`](third_party/README.md) 同步。
- OCR 模型：`det.rten` / `rec.rten` / `ppocrv6_dict.txt`（PP-OCRv6 Small，Apache-2.0）。
  **没有内置默认路径**：用 `--models`（mjs）/ `-Models`（ps1）/ 工具 `modelsDir` 配置 /
  环境变量 `TACK_OCR_MODELS` 指定，缺了会直接报错并提示。来源与校验和见
  [`THIRD_PARTY.md`](THIRD_PARTY.md)；本机原有的一份在 `D:\AIworks\Tack\target\release\models`。
- PowerShell 7 只有 `highlight.ps1` 需要；`highlight.mjs` 不需要（见「引擎 JS 化」）

## 用法

模型目录必须先给一次（没有内置默认路径），后面所有命令都复用：

```powershell
$env:TACK_OCR_MODELS = 'D:\AIworks\Tack\target\release\models'   # 换成你自己的模型目录
```

```powershell
cd kfocr
cargo build --release                      # 首次需联网拉 crates，约 2m40s（含 lto）
cargo build --release --offline            # 依赖已缓存时可离线构建
# 或 cargo build --offline                 # debug，约 60s

pwsh -File ..\scripts\highlight.ps1 -Source '<...>.DVR.mp4' -Release
# → out\<素材名>\highlight_reel.mp4

# 本地 ID 默认自动判定；不想让它猜就显式指定
pwsh -File ..\scripts\highlight.ps1 -Source '<...>.DVR.mp4' -LocalId 乐邦詹士 -Release

# 其他开关
#   -Out <目录>       成片目录（默认 out\<素材名>）
#   -KeepWork         保留中间产物，跑完不删（配合 -Reuse 复跑时用）
#   -Work <目录>      指定中间产物目录（默认系统临时目录）
#   -Models <目录>    OCR 模型目录（默认取 TACK_OCR_MODELS；都没有就报错）
#   -ChunkSize 60     批处理每多少次调用一个进程（默认 60，别超过 60）
#   -Pre 3.5         击杀前留几秒（0-10，默认 3.5）
#   -Post 1.5        击杀后留几秒（0-10，默认 1.5）
#   -Roi "x,w,h,y1,y2,y3"  显式指定击杀条 ROI（源视频像素；默认按分辨率自适应）
#   -ScanFps 2        抽帧帧率（默认 2）
#   -SingleOcr        退回逐帧一个进程，用于 A/B
#   -LegacyExtract    退回逐槽各解码一遍，用于 A/B
#   -Machine          stdout 只出 `HC <json>` 事件行（插件用；人读日志走 stderr）

# 调试：保留中间产物，之后可反复复跑（改判定逻辑时不用重跑 OCR）
pwsh -File ..\scripts\highlight.ps1 -Source '<...>.DVR.mp4' -LocalId 乐邦詹士 -Release -KeepWork -Work .\out\_work
pwsh -File ..\scripts\highlight.ps1 -Source '<...>.DVR.mp4' -LocalId 乐邦詹士 -Release -KeepWork -Work .\out\_work -Reuse
```

JS 引擎（同一套流程与参数，不需要 PowerShell）：

```powershell
node scripts\highlight.mjs --source '<...>.DVR.mp4' --release
node scripts\highlight.mjs --source '<...>.DVR.mp4' --local-id 乐邦詹士 --release --machine
#   --out / --work / --keep-work / --reuse / --chunk-size / --single-ocr / --legacy-extract / --roi 同上
#   --models <目录>：OCR 模型目录（默认取 TACK_OCR_MODELS；都没有就报错）
#   --pre / --post：击杀前后留几秒（默认 3.5 / 1.5，合并阈值 = 两者之和）
#   另可覆盖：--scan-fps <n> / --ocr <kfocr.exe> / --ffmpeg <exe> / --ffprobe <exe>
#   另有 --machine：stdout 只出 `HC <json>` 事件行（与 ps1 的 -Machine 同一份事件格式）
```

`-Release` / `--release` 选用 `kfocr/target/release/kfocr.exe`，不传则用 debug。
`-LocalId` / `--local-id` 默认 `auto`（见下节）；换账号、换局都不用再传，判不出来时它会报错让你显式指定。

## 本地玩家 ID 自动判定

游戏把**本机玩家**的头像框画成淡黄色（队友青、敌方红）。框在行首 = 这次击杀是本机打的，
在行尾 = 本机被击杀。于是：

1. 逐帧对每个槽位量「行首 50% 区域的淡黄像素占比」，≥3% 即视为本机击杀行
   （实测本机行 3.2–5.5%，其余多为 0，个别误检由下一步吸收）；
2. 把这些行的文本归一化后，取**支持度最高的公共前缀**——受害者各不相同，前缀自然收敛到
   杀手名；用「最高支持度」而不是「全体公共前缀」，是为了不被个别误检行拉短；
3. 前缀长度 <2、或前缀等于支持它的某条完整文本（说明把受害者名也吃进去了）时判定失败。

在 5 条素材上验证：`夜色冷` / `乐邦詹士`（×3）/ `比奇堡恶霸鱼`，全部一次判对，
成片与手工指定 ID 时完全一致。

> **ROI 按分辨率自适应。** 基准标定在 2560×1440，运行前用 ffprobe 读源画面，
> 按 `scale = 高度 / 1440` 等比缩放 ROI、横向贴右边缘（击杀条永远右对齐）。
> 1080p 实测：ROI 自动变成 `x=1350 w=570 h=38 slots=94,134,172`，5 杀时间点与 1440p
> 完全一致，OCR 还更快（37.7s vs 54s）。21:9 / 16:10 走同一套规则；HUD 缩放调过的机子
> 识别不出来时用 `-Roi "x,w,h,y1,y2,y3"`（源视频像素）显式覆盖。
>
> 当初把 ROI 从文档附录 A 的 `x=1990 w=560` 放宽到贴右的 760 宽，是因为击杀条右对齐：
> 杀手名 + 受害者名都是 6 个汉字时条子会向左伸出，原宽度会把行首头像和半个名字裁掉
> （实测 `比奇堡恶霸鱼原神转瓦偏运动` 那行），放宽后才量得到黄色头像框。

## 实测（`Valorant 2025.09.14 - 10.48.16.04.DVR.mp4`，120.0s / 2560×1440 / 60fps）

| 阶段 | 结果 |
|---|---|
| 抽帧 | 3 槽 × 240 帧 = 720 张（fps=2，单次解码 + split=3） |
| OCR | 720 次识别，单张 51 ms（release + 批处理）；批长见下 |
| 去重 | 6 条事件（含 1 条 OCR 抖动变体 `夜色冷wzy272`，score 0.83） |
| 成段 | 4 段，链式合并把 108.5 / 112.5 / 113.5 并成一段交战 |
| 产出 | `highlight_reel.mp4` 25.02s / 2560×1440 / 54.8 MB |

| 段 | 源区间 | 时长 | 内容 |
|---|---|---|---|
| #1 | 70.5s | 5.0s | 夜色冷 → 哪里都有雪 |
| #2 | 79.5s | 5.0s | 夜色冷 → jw88488 |
| #3 | 91.0s | 5.0s | 夜色冷 → 暴风无敌大铁牛 |
| #4 | 105.0s | 10.0s | 夜色冷 → 美丽绝育大蟑螂、wzy27（并成一段交战） |

### 抽帧：单次解码 vs 逐槽解码（同素材同参数，A/B 实测）

| 实现 | 耗时 | 备注 |
|---|---|---|
| 逐槽 3 次完整解码（旧 `demo.ps1`） | **35.77s** | 每槽各解码一遍整片 |
| 单次解码 + `split=3`（现默认） | **12.09s** | **2.96×** |

两者产出的 720 张 PNG **逐帧 SHA256 完全一致**，属纯提速、无行为变化。
`-LegacyExtract` 可切回旧实现复测。

滤镜图（中间产物里的 `fg.txt`，由脚本按槽位数与 ROI 自动生成；下面是 2560×1440 基准下的取值）：

```
fps=2,split=3[b0][b1][b2];[b0]crop=760:50:1800:125[s0];[b1]crop=760:50:1800:178[s1];[b2]crop=760:50:1800:230[s2]
```

其它分辨率按 `scale = 高度 / 1440` 等比换算并贴右边缘（1080p 为 `570:38:1350:…`）。

ffmpeg 9.0 已移除 `-filter_complex_script`，须用 `-/filter_complex <file>`。

### 全流程分阶段耗时（同素材，120s）

| 阶段 | debug | release | release + 批处理 |
|---|---|---|---|
| 抽帧（单次解码 + split=3） | 12.1s | 12.1s | 12.2s |
| OCR（720 次） | 116.6s | 53.0s | **36.8s** |
| 切片 4 段 + concat 拼接 | 8.9s | 8.5s | 8.4s |
| **合计** | **138.0s** | **74.0s** | **57.8s** |

单帧 OCR 从 162ms（debug）→ 73ms（release）→ 51ms（release + 批处理）。

### 批处理：省 1.45×，但批长有拐点

`kfocr --list <文件>` 一次进程内处理多张图，模型只加载一次。批长对速度影响极大：

| 批长 | OCR 总耗时 | 单帧 |
|---|---|---|
| 逐帧一个进程（`-SingleOcr`） | 52.2s | 72ms |
| 30 帧/批 | 35.9s | 50ms |
| **60 帧/批（默认）** | **37.0s** | 51ms |
| 120 帧/批 | 64.8s | 90ms |
| 一次 720 帧 | 68–90s | 95–133ms |

同一台机、同一批帧，只改批长，单帧耗时相差 2.5×。批长超过约 60 后进程内会明显劣化，
脚本因此按 `-ChunkSize`（默认 60）分段调用。

与 CPU 亲和性、每帧 stderr 日志量都无关：做过 P 核 / E 核绑定对照（90–101ms 无差异）
和 `--quiet` 对照（60.2 / 65.3s，与不静音无差别），均不改变结论。原因未完全定位。

### 测量过程的坑（备查）

这台机在持续跑分下会明显降频：同一条命令在不同时间点能差 2×（40 帧批早期 47.5ms/帧、
后期 90ms/帧）。因此本目录所有性能结论都取自成对/交替测量（同一时刻的 A、B 对比），
绝对秒数只用于量级参考。中途曾因这一点得出「批处理更慢」的错误结论，靠 6 轮交替配对才纠正。

## 与旧 `demo.ps1` 的差异：修了 6 个 bug

1. **`[math]::Max(0, $e.t - $PRE)` 绑定 int 重载**：70.5 被截成 70，每段起点少 0.5s。
   改为 `[math]::Max([double]0, ...)`。
2. **合并阈值 4.0，文档规定 4.5**：`108.5 → 112.5` 间距恰好 4.0，用 4.0 时两次击杀不会被
   并成一段交战。现已改为 **前摇 + 后摇 = 5.0s**（见下面第 3 条）。
3. **段与段会重叠，同一帧被剪进两个切片**。前摇 3.5s + 后摇 1.5s = 5.0s，两次击杀间隔
   4.5–5.0s 时，后一段的前摇会压到前一段的后摇上。实测 `2025.09.21` 素材：113.0s 与
   117.5s 两次击杀，前段到 114.5s、后段从 114.0s 开始，重叠 0.5s，成片里同一行击杀条
   （`夜色冷 → 乌梅子酱`）出现两次。

   两层修法：
   - 段间钳制不重叠（后一段的起点是硬边界）；
   - 合并阈值改为 `Pre + Post`：间隔小于这个值说明后一杀的前摇压在前一杀的后摇上，
     本来就算同一次交战（killfeed 一行也正好停留 4-5s）→ 并成一段，从根上避免重复。

   同时 `MaxDuration` 只用于抑制无限增长，不再吃掉最后一杀的后摇（截断后补回）。
4. **合并时与段首 `anchor` 比较，而不是与上一个已并入的事件比较**：抖动变体 `113.5`
   离段首 108.5 已 5.0s，会切出 `110.0s` 的新段，与 `105–114` 重叠、成片里同一段出现两次。
   改为记录 `lastT` 做链式合并。
5. **本地 ID 用 `Contains` 匹配，应为前缀匹配**（文档 §6 坑 2）。killfeed 一行是
   「杀手名 + 被杀者名」连写，`Contains` 会把「敌人把我杀了」也算成我的击杀。
   `2026-11-11 - 23.18.09` 素材实测：45 条含本地 ID 的命中里有 14 条是死亡
   （`贤者乐邦詹士` ×10、`心碎小熊乐邦詹士` ×4），旧逻辑会剪进自己被杀的片段。
   已改为 `StartsWith`，并在归一化文本上再校验一次。
6. **「按文本去重」这个思路本身是错的**。文档 §6 坑 3 写的是「相同归一化文本只取最早
   出现的时间戳」，旧 `demo.ps1` 也是这么做的。但 killfeed 是队列而不是集合：
   **贤者（奶妈）的复活、暮蝶的自我复活，会让同一个敌人在同一回合里被同一个人杀多次，
   文本完全一样**（一回合理论上最多 7 杀）。再加上 120s 回放缓冲本身就横跨 1–2 个回合
   （一回合 100s + 购买阶段），跨回合重名也是常态。

   `2026-11-11 - 23.21.53` 素材实测：实际 5 次击杀只输出 3 次（`乐邦詹士Mete0r4`
   出现在 18.5s 与 107.0s、`乐邦詹士困了又困` 在 7.0s 与 108.0s，都属不同回合）。

   改成按**屏幕占位**重建（`scripts/lib/events.ps1`）：

   - 每条文本的命中切成若干「连续出现时段」，段内允许 ≤ 3.0s 的 OCR 漏帧
     （实测单次停留内会出现 2.5s 空档）；
   - 每段产出「该段内同时在屏的最大条数」个事件——同屏两格是同一条文本，就是实打实两次击杀；
   - 单段时长上限 6.0s：一行不可能停留更久，超过即说明是两段首尾相接（首行过期后 1.5s 又出现）。

   覆盖的判定，见 `scripts/test-events.ps1`（10 个合成用例，全部通过）：

   | 场景 | 期望 |
   |---|---|
   | 单次击杀，停留 5s | 1 |
   | OCR 漏帧 2.5s 空档 | 1 |
   | 跨回合重名，间隔 90s | 2 |
   | 复活后再杀，首行过期 1.5s 后重现 | 2 |
   | 复活三连杀 | 3 |
   | 同屏两条同名（slot0 + slot1） | 2 |
   | 同屏两条 + 之后又一条 | 3 |
   | 两个不同受害者同一时刻 | 2 |
   | 列表整体上移 | 1 |
   | 无命中 | 0 |

   残余边界：ROI 只覆盖 3 个槽位，同屏出现第 4 条及以上的击杀时会看不到最新那条
   （新条目追加在下方）。要覆盖到 5 格需把槽位数组扩到 5，OCR 次数从 720 涨到 1200
   （约 +67%）。当前素材未触发。

## 与文档数值的差异

文档 §5.3 记 5.5 / 5.0 / 5.0 / 10.0 = 25.52s；本次实测 5.0 / 5.0 / 5.0 / 10.0 = 25.02s。
差异只在第 1 段：`74.0 - 3.5 = 70.5` 起，后摇 1.5s 只到 75.5，即 5.0s；
文档写「70.5s 起 5.5s」两栏自身不自洽。其余三段完全一致。

## 引擎 JS 化（M3-B，已落地）

`scripts/highlight.mjs` 是 `highlight.ps1` 的完整替代：抽帧、OCR、事件重建、切片、拼接全部
在 Node 里编排，判定逻辑在 `scripts/lib/events.mjs`（与 `events.ps1` 逐函数对应）。
**除了 `kfocr` 与 `ffmpeg`，不再需要任何外部运行时**（不需要 PowerShell）。

唯一换做法的环节是「行首黄框」采样：PS 版用 `System.Drawing` 逐像素读 PNG，JS 版改成
`kfocr --marker 0.5`（Rust 里刚解码完的图，顺手算左 50% 的淡黄占比，比再起一个进程快）。
`--marker` 的采样步长与阈值和 `Get-SelfMarkerScore` 逐条对齐。

验证分三层：

| 层 | 内容 | 结果 |
|---|---|---|
| 合成用例 | `test-events.mjs` 移植 `test-events.ps1` 全部用例，另加 `psRound` / ROI 取整 | 48 项全过，结果与 PS 版逐项一致 |
| 像素采样 | `test-marker.mjs`：同一批 206 张裁剪图，System.Drawing vs `kfocr --marker` | 最大差 **0.000000** 个百分点，阈值分类 0 处不一致 |
| 金样（真素材） | `test-parity.mjs`：PS 跑一遍留现场，JS `--reuse` 复用同一份抽帧与 OCR | 6 条素材的 localId / kills / segments 逐条一致，成片 **SHA256 完全相同** |

金样结果（JS 耗时是 `--reuse` 复用 PS 抽帧/OCR 后的判定 + 切片，不代表完整耗时）：

| 素材 | localId | 击杀 | 段 | PS | JS | 成片 SHA256（前 12 位） |
|---|---|---|---|---|---|---|
| 2025.09.14 - 10.48.16.04 | 夜色冷 | 5 | 4 | 52s | 8s | `68CADCFBC179` |
| 2025.09.21 - 17.16.07.08 | 夜色冷 | 5 | 2 | 54s | 7s | `BC3885A3667F` |
| 2026.10.13 - 19.52.39.02 | 比奇堡恶霸 | 7 | 3 | 56s | 7s | `379269E4540A` |
| 2026.11.11 - 23.18.09.02 | 乐邦詹士 | 4 | 2 | 51s | 4s | `7C26D8551778` |
| 2026.11.11 - 23.18.37.03 | 乐邦詹士 | 3 | 2 | 15s | 3s | `AA683EAD04D8` |
| 2026.11.11 - 23.21.53.04 | 乐邦詹士 | 5 | 4 | 56s | 9s | `08BA0D7A95FE` |

最近一次比对报告：[`docs/parity-report.json`](docs/parity-report.json)（原样拷自 `out/_parity/report.json`，
`out/` 不入库）；`node scripts/test-parity.mjs`
可重跑（约 7 分钟，默认跑完删现场，`--keep` 保留）。

**移植时踩到的三个语义坑**（都在代码里处理了）：

1. **取整是 banker's rounding**：PS `[math]::Round(172.5)` = 172（进偶数），JS `Math.round` = 173。
   1080p 的第三个槽位正好是 `230 × 0.75 = 172.5`，差 1px 就会改变 OCR 输入。
   现在统一走 `lib/round.mjs` 的 `psRound`，ROI 换算与事件时间戳都用它。
2. **汉字判定范围**：.NET 的 `\p{IsCJKUnifiedIdeographs}` 是 U+4E00–9FFF 这个块，
   不是 Unicode 的 `Unified_Ideograph`（后者含扩展区、部首兼容字）。JS 侧固定用
   `/[\u4E00-\u9FFF]/`，两边剥噪声的结果才一致。
3. **子进程输出用临时文件而不是管道**：DSH 的 workspace-write 沙箱禁止子进程开命名管道，
   Node 的 `stdio: 'pipe'` 会直接 EPERM；`lib/proc.mjs` 重定向到普通文件再读，沙箱内外都成立，
   也顺带避开「输出太多写满管道」的死锁。

**插件侧**：`engine: auto`（默认）先跑 JS 引擎，早期失败才回落 PS；`js` / `ps` 可强制。
Electron 里没有独立 node，Host 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 把 DSH 自己的 exe 当 node 跑。
Host 半的改动要重启 DSH 才生效（`node scripts/test-plugin.mjs [--spawn]` 是它的独立自测）。

## DSH 插件（0.1.0）

`plugin/` 是一个 DeepSeek Harness bundle（`@local/auto-reel`），把上面这条流水线包成一个
对话里的工具 + 一张工具卡片 + 一个右侧栏面板。引擎默认是 JS（`highlight.mjs`，**不需要 PowerShell**）；
`engine: auto` 时若 JS 引擎在产出击杀前就失败，会自动用 `highlight.ps1` 重试一次。
插件只负责调度、进度和展示。

**安装**（一次性，profile 级）：`plugin_manager` 的 `install_bundle` 指向 `D:\AIworks\AutoReel\plugin`，
或在 **插件** 页用「添加插件」选这个目录。装完刷新页面（Client 半要重新载入）。
装的是**源码目录**（不是 tgz）时包内没有 `models/`，需要在 profile 的 `cordis.patch.yml` 里给它
指定模型目录，否则 `/autoreel/api/health` 的 `models` 一项会红：

```yaml
- id: auto-reel
  name: "@local/auto-reel"
  config:
    modelsDir: 'D:\AIworks\Tack\target\release\models'
```

> ⚠️ **从「源码目录（link）」换成「tgz / Release URL」安装时，先备份 `plugin/`。**
> 实测 pnpm 会把旧的 `link:` 依赖替换成真实包，替换时顺着 junction 把**链接目标目录的内容删掉**
> ——也就是仓库里的 `plugin/` 会被清空（2026-11-18 实际踩到，用 `git restore -- plugin` 恢复）。
> 要么先 `remove_bundle`，要么先提交/备份再装。

**用法**：在对话里说「把最近一条回放剪一下」。模型调用 `auto_reel`：

| 参数 | 说明 |
|---|---|
| `source` | 回放路径；省略或 `latest` = 回放目录里最新的 `.DVR.mp4`（也可用面板里指定的默认回放） |
| `localId` | 本机玩家 ID，默认 `auto`（行首黄色头像框推断） |
| `roi` | 击杀条 ROI `"x,w,h,y1,y2,y3"`（源视频像素）；默认 `auto` = 按分辨率相对 1440p 等比缩放、贴右边缘，只有自动 ROI 认不出击杀时才需要显式给 |
| `waitSeconds` | 阻塞等待上限，默认 45（夹在 5–600）；超时返回作业 id，用 `job_output` 继续收 |

跑完后工具卡片显示：进度、击杀明细、可拖动的成片播放器、打开目录按钮。
成片仍是 `out/<素材名>/highlight_reel.mp4`。

**右侧栏面板**：打开右侧栏 → 引导页的 **AutoReel** 卡片，里面可以直接改：

| 项 | 默认 | 说明 |
|---|---|---|
| 回放目录 | `%USERPROFILE%\Videos\VALORANT` | 下拉列表的来源；右侧「浏览…」弹系统文件夹对话框 |
| 回放文件 | 空 = 最新一条 | 指定某条回放，或每次自动取最新 |
| 输出目录 | 仓库 `out/` | 成片目录，不存在会创建；同样可「浏览…」选 |
| 击杀前 / 击杀后 | 3.5s / 1.5s | 0–10s；合并阈值自动 = 前 + 后 |

「保存设置」写入 `%LOCALAPPDATA%\AutoReel\settings.json`，立即生效、不用重启；
「剪这条回放」直接用面板当前值出片，进度和播放器就在面板里。面板与工具共用同一条执行路径，仍然串行。

**接口**（本机 HTTP，供卡片与面板用；全部在 `/autoreel` 下）：`/autoreel/api/health`（逐项自检）、
`/autoreel/api/replays?dir=`、`/autoreel/api/settings`（GET/POST）、`/autoreel/api/cut`（POST）、
`/autoreel/api/pick-dir`（POST，系统目录对话框）、`/autoreel/api/runs/latest`、`/autoreel/api/runs/<id>`、
`/autoreel/api/library`、`/autoreel/api/reveal`（POST）、`/autoreel/api/client-graph`（诊断：客户端模块有没有进启动图）、
`/autoreel/media/<素材名>/highlight_reel.mp4`（支持 Range；面板刚剪完、输出目录还没保存时用
`/autoreel/media/run/<runId>/highlight_reel.mp4`）。

配置项、限制和事件格式见 [`plugin/docs/DETAIL.md`](plugin/docs/DETAIL.md) 与
[`docs/PLUGIN-PLAN.md`](docs/PLUGIN-PLAN.md)。

**分发给别人**：`pwsh scripts/build-plugin.ps1` 会产出 `dist/auto-reel-<version>.tgz`
（**自带引擎、`bin/kfocr.exe` 与 `models/` 模型**，实测 27.1 MB；`-NoModels` 减到 2.2 MB）。

DSH 的安装入口（`plugin_manager` 的 `install_bundle`，或插件页「添加插件」）接受四种写法：

| 写法 | 例子 | 说明 |
|---|---|---|
| 本地目录绝对路径 | `D:\AIworks\AutoReel\plugin` | 开发用；链到仓库，改了代码刷新即生效 |
| 本地 `.tgz` 绝对路径 | `D:\下载\auto-reel-0.1.0.tgz` | 自包含，装好即用 |
| **HTTPS tarball URL** | `https://github.com/Yur1Chen/AutoReel/releases/latest/download/auto-reel.tgz` | 把 tgz 传到 GitHub Release 当资产，「填一个地址就装」走这条 |
| git 地址 | `github:Yur1Chen/AutoReel#<40 位 commit>&path:/plugin` | 装 `plugin/` 子包；包内没有 `engine/`、`bin/`、`models/`，只适合开发调试 |

机器上只需 `ffmpeg` 9（Node 由 DSH 自带；`pwsh` 7 仅在 `engine: ps` 或回落时需要）；装好后
`/autoreel/api/health` 会逐项自检并显示当前引擎。三条路的取舍、不能直装的原因和剩余待办，
见 [`docs/PUBLISHING.md`](docs/PUBLISHING.md)。

**仓库里不放什么**：`out/`（成片与录像画面）、`dist/`（构建产物与 tgz）、`kfocr/target/`
（约 1.46 GB 编译缓存）都在 [`.gitignore`](.gitignore) 里；金样比对的证据另存为
[`docs/parity-report.json`](docs/parity-report.json)。

**公开仓库的已知限制**：`kfocr` 的 OCR 依赖 Tack（作者自研、尚未完成），仓库里用的是
[`third_party/`](third_party/README.md) 里的**源码快照**——源码可构建，但 Tack 的更新不会自动同步。
第三方许可已核实：模型权重是 PP-OCRv6 Small（**Apache-2.0**），打包时会带上 Apache-2.0 全文与
NOTICE，明细见 [`THIRD_PARTY.md`](THIRD_PARTY.md)；分发与待办清单见
[`docs/PUBLISHING.md`](docs/PUBLISHING.md)。

**ROI 按分辨率自适应**：引擎先 ffprobe 读源画面，按 `scale = 高度 / 1440` 等比缩放击杀条
区域并贴右边缘。1080p 实测与 1440p 的击杀时间点完全一致；21:9 / 16:10 走同一规则；
游戏内 HUD 缩放调过时可用 `-Roi "x,w,h,y1,y2,y3"`（或工具 `roi` 参数）覆盖。

## 实现状态（文档结论 vs 代码）

### 已实现

| 项 | 文档出处 | 结果 |
|---|---|---|
| release profile（opt3 + lto + cgu=1） | §8 | OCR 116.6s → 53.0s（2.20×），全流程 138s → 74s |
| 三槽单次解码 + `split=3` | §8.2 | 35.77s → 12.09s |
| 批处理 OCR（`--list` + 分段） | 本文档 §8 | 52.2s → 36.8s；批长必须 ≤60 |
| 引擎 JS 化（去掉 PowerShell 依赖） | [PLUGIN-PLAN §11](docs/PLUGIN-PLAN.md) | `scripts/highlight.mjs` + `kfocr --marker`；48 项合成用例、6 条素材金样、成片 SHA256 全一致。插件默认 `engine: auto` → 走 js，只有 JS 在产出击杀前就失败才回落 ps（改 Host 端需重启 DSH） |
| ROI profile 外置（换分辨率/游戏只换 profile） | §7.2 | 按 ffprobe 读到的分辨率相对 1440p 等比缩放，`-Roi` 可显式覆盖 |

### 未实现

| 项 | 文档出处 | 现状 |
|---|---|---|
| 切片保留全部音轨 `-map 0:v:0 -map 0:a -c:a copy` | §12.6 | 未加多音轨 `-c:a copy`；当前切片已带默认音轨（转 AAC 192k），本素材只有 1 条音轨，多音轨丢失问题暂时不可见 |
| 几何门限（字框高 20–40 / 宽 ≥240） | §6 坑 4 | 未实现；本素材未触发购买阶段噪声 |
| 槽位数量做成可选项（`-SlotCount 3` 或 `5`，应对同屏 4+ 杀） | §9 边界 4 | 固定 3 槽；扩到 5 格 OCR 次数 720 → 1200（约 +67%），按需开启，不设为默认 |

