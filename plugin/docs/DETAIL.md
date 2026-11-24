# AutoReel 击杀集锦

把 NVIDIA 即时回放（`.DVR.mp4`）自动剪成 Valorant 击杀集锦：**抽帧 → 击杀信息栏 OCR → 重建击杀事件 → 切片 → 拼接**。
产出一份 `highlight_reel.mp4`，直接出现在对话里的工具卡片中，可播放、可拖进度、可一键在文件管理器里打开成片目录。
「打开目录」直接用 DSH 自己的 open-in-app 路由（`GET /open-in-app/apps` → `POST /open-in-app/open`，
`app` 取 `explorer` / `finder` / `filemanager`），页面内 fetch 自带浏览器鉴权；
宿主没挂这套路由时退回插件自己的 `/api/reveal`。

## 它怎么判断该剪哪一段

游戏把本机玩家的头像框画成淡黄色（队友青、敌方红）。框在行首 = 这次击杀是本机打的。
插件据此**自动识别本机 ID**，再按「屏幕占位」重建击杀：killfeed 是队列而不是集合 ——
贤者复活、暮蝶自我复活会让同一个敌人在同一回合被多次击杀，文本完全一样，
所以同一条文本在不同时间出现、或同屏同时出现两格，都算多次真实击杀。

## 引擎

默认 `engine: auto`：优先跑 `highlight.mjs`（Node，由 DSH/Electron 提供，**不需要 PowerShell**），
它在「还没产出任何击杀事件」之前就失败时，自动用 `highlight.ps1` 重试一次；已经出过击杀就不回落，
直接把错误抛出来（避免白跑第二遍 OCR）。两个引擎输出同一份 `HC <json>` 事件流，
卡片、作业进度与 HTTP 接口完全一致，工具结果里会标 `engine: js` 或 `engine: ps`。

Electron 里没有独立的 `node.exe`：Host 用 `process.execPath`（DSH 自己的 exe）+ `ELECTRON_RUN_AS_NODE=1`
来跑 `highlight.mjs`；如果机器上装的不是 Electron 版，也可以把 `nodePath` 配成真正的 `node.exe`。

## 侧边栏面板

右侧栏里有一个 **AutoReel** 页签（从侧栏引导页的 AutoReel 卡片打开），把常用设置和出片放在一起：

| 字段 | 说明 | 约束 |
|---|---|---|
| 回放目录 | 下拉列表的来源，改完即时按新目录列出文件 | 绝对路径、必须是存在的目录 |
| 回放文件 | 从目录里的 `.DVR.mp4` 选一条；选「最新一条」= 每次自动取最新 | 绝对路径、必须是文件，可留空 |
| 输出目录 | 成片写到 `<输出目录>/<素材名>/highlight_reel.mp4` | 绝对路径，不存在会创建 |
| 击杀前（秒） | 每个击杀往前留几秒 | 0.5–10，步长 0.5 |
| 击杀后（秒） | 每个击杀往后留几秒 | 0.5–10，步长 0.5 |

「合并阈值」是只读的 `击杀前 + 击杀后`：两次击杀间隔小于它就算同一次交战，并成一段。

回放目录和输出目录右侧都有 **浏览…**：调用 DSH 的目录选择服务，在本机桌面弹出系统文件夹对话框；
远程/非本机桌面环境没有原生选择器时，接口会返回原因，仍然可以直接输入路径。

「打开目录」优先走 DSH 的 `open-in-app` 路由（页面内 fetch 自带鉴权，能正确把文件管理器带到前台），
失败才退回插件自己的 `/api/reveal`（`explorer /select`）。

- **保存设置**：写进本机设置文件，立即生效，不用重启插件；
  设置文件覆盖插件 `config` 里的同名默认值。
- **剪这条回放**：用面板里当前的值直接跑（不要求先保存），进度和结果就在面板里；
  它和 `auto_reel` 工具共用同一个执行路径，但面板发起的任务没有会话作业，靠面板自己轮询。
- 面板默认浅色，右上角可在浅色 / 深色之间切换；运行中点 **取消** 会连同引擎的子进程一起中断。
- 面板和工具仍然串行：一次只跑一个剪辑任务。

## 用法

在对话里直接说：

- 「把最近一条回放剪一下」→ 用回放目录里最新的 `.DVR.mp4`
- 「剪 D:\Videos\VALORANT\Valorant 2026.11.11 - 23.21.53.04.DVR.mp4」→ 指定文件
- 「用 ID 乐邦詹士 重剪刚才那条」→ 自动识别失败时显式指定

模型调用工具 `auto_reel`（参数：`source` / `localId` / `waitSeconds`）。
120 秒素材默认档约 20s：工具默认阻塞等 45 秒，没跑完就返回作业 id，
之后用 `job_output` 收结果；会话头部的作业面板能看到实时进度，`job_kill` 可以中断。

产出位置：`out/<素材名>/highlight_reel.mp4`（素材名 = 文件名去掉 `Valorant ` 前缀与 `.DVR` 后缀）。

## 依赖

| 组件 | 用途 | 默认值 |
|---|---|---|
| `engine/highlight.mjs` | **默认引擎**（缩帧、OCR、切片、拼接；不需要 PowerShell） | 仓库内 `scripts/`，包内 `engine/` |
| `engine/highlight.ps1` | 回落引擎（`-Machine` 模式） | 同上 |
| Node / Electron | 跑 JS 引擎 | DSH 自带，不用另装 |
| PowerShell 7 | 仅 `engine: ps` 或 auto 回落时需要 | `pwsh`（PATH，可选） |
| ffmpeg / ffprobe 9.0 | 抽帧、切片、拼接 | PATH |
| `kfocr.exe` | 击杀信息栏 OCR + `--marker` 行首黄框采样 | `kfocr/target/release/kfocr.exe` |
| OCR 模型 | `det.rten` / `rec.rten` / `ppocrv6_dict.txt` | 配置项 `modelsDir` / 环境变量 `TACK_OCR_MODELS`（无内置默认路径；包内自带 `models/`） |

## 分辨率

ROI 不写死：每次运行先用 ffprobe 读源画面，按 `scale = 高度 / 1440` 等比缩放击杀条区域，
并保持「贴右边缘」的定位，所以 1080p / 2K / 4K / 21:9 / 16:10 都不用额外配置。
工具结果里会带上实际用的规格：

```
media: 1920x1080 @60fps  profile=scaled-1920x1080  scale=0.75
```

1080p 实测与 1440p 的击杀时间点完全一致。只有把游戏内 HUD 缩放调离默认值、或换了别的游戏时，
才需要用 `roi` 参数（`"x,w,h,y1,y2,y3"`，源视频像素）显式指定。

`GET /autoreel/api/health` 会逐项自检并给出缺哪一项。

## 配置

写在插件行（Loader 的 `config`）里，全部可省略：

```yaml
- id: auto-reel
  name: '@local/auto-reel'
  config:
    replaysDir: 'D:\Videos\VALORANT'   # 回放目录，默认 %USERPROFILE%\Videos\VALORANT
    outputDir: 'D:\AIworks\AutoReel\out'
    scanFps: 2                          # 扫描帧率，2fps 的时间精度 ±0.5s
    chunkSize: 60                       # OCR 分段批长，超过 60 会明显变慢
    engine: auto                        # auto（js 优先、早期失败回落 ps）| js | ps
    # nodePath: 'node.exe'              # 默认用 DSH 自带运行时（Electron 走 ELECTRON_RUN_AS_NODE）
    waitSeconds: 45                     # 工具阻塞等待上限
    localId: auto                       # 默认本机 ID
    sourcePath: ''                      # 指定单个回放；空 = 回放目录里最新一条
    pre: 3.5                            # 击杀前秒数（0–10，面板最小 0.5），侧栏面板可改
    post: 1.5                           # 击杀后秒数（0–10，面板最小 0.5），侧栏面板可改
    # 以下几项只有真的换档才需要写（默认档 = 与旧版逐字节一致的产物，见 docs/BENCHMARKS.md）
    encoder: libx264                    # libx264（默认）| nvenc（快约 10%，同画质体积 1.7×）| auto
    fastCopy: false                     # true = 切片 -c copy 无损直剪（9s → 0.6s，体积约 2×）
    extract: full                       # full（默认）| keyframe（GOP≤0.5s 时才生效，抽帧快 7×）
    ocrJobs: 0                          # 并发 kfocr 分块进程数，0 = auto（核数/4，最多 4）
    cutJobs: 1                          # 切片并发数（实测 4 路只快 0.2s）
```

`sourcePath` / `pre` / `post` 也能在侧栏面板里改；面板保存的是**本机覆盖值**，优先于这里的默认值。
`encoder` / `fastCopy` / `extract` 这些速度开关只在配置文件里生效（面板不暴露，避免误操作改产物）。

120 秒素材默认档端到端约 20s（旧版约 51s）；`fastCopy` + `extract: keyframe` 全开约 6s，代价见 docs/BENCHMARKS.md。

## 限制

- **Windows + NVIDIA 即时回放专用**：ROI 与「淡黄头像框」都按 2560×1440 的 Valorant 击杀条标定。
- 同屏同时出现 4 条及以上击杀时，第 4 条之后看不到（固定 3 个槽位）；把槽位扩到 5 会让 OCR 次数 +67%。
- 一次只跑一个剪辑任务（OCR 吃满 CPU）；重复请求会被拒绝并提示当前任务 id。
- 面板发起的任务没有会话作业 id，不会出现在会话头部的作业面板里；进度由面板自己轮询。
- 剪辑结果不写回会话日志，只写磁盘；插件重启后 `/api/library` 仍能列出 `out/` 里的历史成片。
