# AutoReel → DeepSeek Harness 插件：方案调研

> 调研对象：本机运行中的 DSH `@deepseek-ai/dsh@0.2.2-rc.3`（Electron 44.7 / Node 24.21，Desktop profile）。
> Web GUI 端口每次启动都会变（调研时 51548，2026-11-18 复核时 51200），文中出现的端口只是当时的记录。
> 文中"已核实"均指读过安装包源码或用 Inspect 实测过；未核实项集中在 §2.3。

## 0. 结论（TL;DR）

**可行，且不需要给 DSH 打补丁。** 推荐做一个 bundle 包 `@local/auto-reel`，双半结构：

- **Host 半**：一个工具 `auto_reel` + 一个后台作业生产者（进度）+ 几条本机 HTTP 路由（供 UI 与视频播放）。
- **Client 半**：一张工具卡片（击杀表 + `<video>` 播放器 + 打开目录），挂在 `tool.call.toolview`。

**引擎**：第一版不重写——bundle 直接 spawn 现有 `scripts/highlight.ps1`，给脚本加一个 `-Events`
（最终定名 `-Machine`，见 §0.5 坑 1）开关输出机器可读进度；判定逻辑的 JS 化放到 M3，用已有素材做金样比对再切换。
（实际已完成：M3-B 落地后**默认走 JS**，PS 只在 JS 产出击杀前就失败时回落，见 §0.5 / §11.4。）

**关键发现**：`defineTool()` 只是构造器，产出的就是普通对象（`{name, description, parameters, output, execute}`），
所以 bundle **一个 `@deepseek-ai/*` 包都不用 import**，也就没有版本耦合 / peer 依赖 / 网络安装问题。
同理，自定义 `@Remote` 命名空间需要 typert 代码生成，手工 bundle 走不通，改用 `ctx.webServer` 路由即可。

---

## 0.5 实施状态（2026-11-18：M0/M1/M2/M3-B 已落地，已重启实测）

已按拍板结论实施：**首版 UI 是工具卡片**、**回放目录默认 `%USERPROFILE%\Videos\VALORANT`**、
**首版就自动识别 ID**。引擎先走 A（包 PowerShell）；M3-B 落地后**默认切到 B（JS）**，A 只作为回落。

| 项 | 状态 | 说明 |
|---|---|---|
| `scripts/highlight.ps1 -Machine` | ✅ | stdout 只出 `HC <json>`，人读日志走 stderr；25 条事件（stage/progress/localId/kills/segments/result） |
| bundle `plugin/` | ✅ | 已 `install_bundle` 到 desktop profile，`fiberPhase: active` |
| 工具 `auto_reel` | ✅ | 出现在模型工具表；实测跑通两条路径（45s 超时返回 job id / 70s 等到完成） |
| 后台作业 + 进度 | ✅ | `ctx.jobs`，作业面板可见；`job_output` 取到完整 JSON 结果 |
| HTTP 路由 | ✅ | health 全绿；media 支持 Range（206）；traversal 403；library/runs 正常 |
| ROI 按分辨率自适应 | ✅ | ffprobe 读源画面 → `scale=高度/1440` 等比缩放 + 贴右边缘；1080p 实测与 1440p 击杀时间点完全一致；`-Roi` / 工具 `roi` 参数可覆盖 |
| 分发包 | ✅ | `scripts/build-plugin.ps1` → `dist/auto-reel-0.2.0.tgz`（约 28 MB，自带引擎/`kfocr.exe`/模型）；解包后只用包内资产跑通完整素材 |
| Client 工具卡片 | ✅ | 已实测：进度、击杀两列、16:9 播放器、「打开目录」都正常；支持 HMR 热替换 |
| 判定逻辑 JS 化（引擎 B） | ✅ | `scripts/highlight.mjs` + `kfocr --marker`；48 项合成用例、6 条素材金样（localId/kills/segments 逐条一致、成片 SHA256 相同）；插件支持 `engine: auto|js|ps`（auto 优先 js、JS 产出击杀前失败才回落 ps）。2026-11-18 重启后实测：health 全绿、`engine: js`，89 MB 素材 3 杀 / 2 段 / 12.4s 出片，成片 SHA256 与金样一致 |
| 右侧栏面板（设置 + 直接剪） | ✅ | 0.1.0：回放目录/文件、输出目录、击杀前/后秒数可改；目录可「浏览…」调用系统对话框；保存到 `%LOCALAPPDATA%\AutoReel\settings.json`，即时生效 |
| 作品库页 / `/cut` 命令 | ⬜ | M3 剩余项，未开始。数据面已就绪：`/autoreel/api/library` 能列 `out/` 里的成片并带 `mediaUrl`，只差 UI 页面与命令入口 |

实施中撞到、方案里没写到的六个坑（都已修）：

1. **`-Events` 不能当开关名**：PowerShell 变量名不区分大小写，`$Events` 开关和脚本里的
   `$events`（击杀事件）是同一个变量，赋数组给 `[switch]` 直接抛
   `无法将值 System.Object[] 转换为 SwitchParameter`。改名 `-Machine`。
2. **Cordis 必须声明 `inject`**：不声明就取 `ctx.webServer` 会报
   `cannot get property "webServer" without inject`，插件激活失败。
3. **prefix 路由不能带尾斜杠**：`dsh-host-webserver` 的匹配是
   `pathname === prefix || pathname.startsWith(prefix + '/')`，注册 `/autoreel/media/`
   永远匹配不到 `/autoreel/media/x`。
4. **媒体路由必须自己实现 Range**：视频拖进度条需要 206，`ctx.webServer` 只给原始 req/res。
5. **打开目录别自己 spawn explorer**（客户端侧三个连环坑）：
   - `explorer /select,` 和路径必须分开传，拼成一个参数时 Node 给整串加引号，explorer 静默退出；
   - `ctx.remote.session` 是**带点号的独立注入项** `remote.session`，只注入 `remote`
     会在取 `.session` 时抛 `cannot get property "remote.session" without inject`；
   - 更省事的是直接用 DSH 的 `open-in-app` 路由：`GET /open-in-app/apps` →
     `POST /open-in-app/open { app, path }`，页面内 fetch 自带浏览器鉴权
     （同一地址用 curl 打是 401）。实测可用，`app` 在 Windows 上取 `explorer`。
6. **Electron 里没有 node.exe**：插件跑 JS 引擎得用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，
   否则 spawn 出来的是第二份 DSH 应用。实测 `DeepSeek Harness.exe` 带这个变量能执行
   `highlight.mjs`（需要 exe 旁边的 `icudtl.dat` / `v8_context_snapshot.bin`，安装目录本来就有）。
   `engine: auto` 另外留了「JS 早期失败回落 ps」的保险。

---

## 1. 现状盘点：可复用的三个边界

| 层 | 实现 | 现状 | 插件中的角色 |
|---|---|---|---|
| 抽帧 | ffmpeg 9.0，单次解码 + `split=3` | 12.1s / 120s 素材 | 原样调用 |
| OCR | `kfocr.exe`（Rust + tack-ocr），`--list` 分段批处理 | 720 帧 36.8s（51ms/帧） | 原样调用，批长 60 是拐点 |
| 判定 | `scripts/lib/events.ps1`（占位模型、复活/跨回合、变体合并、段合并） | 10 个合成用例通过 | **可迁移的纯逻辑**（唯一有"知识"的部分） |
| 切片 | ffmpeg x264 veryfast crf20 + concat | 8.4s | 原样调用 |

运行期依赖（本机已实测齐全）：`ffmpeg/ffprobe 9.0`、`pwsh 7.6.10`、
`kfocr/target/release/kfocr.exe`、模型目录 `D:\AIworks\Tack\target\release\models`（30.5 MB，`TACK_OCR_MODELS` 可覆盖）。
产出契约很干净：`out/<素材名>/highlight_reel.mp4`，一个素材一个目录 —— 天然适合做"作品库"。

结论：**AutoReel 已经是一个"引擎"，插件要做的是外壳**，不是把算法搬进 TypeScript。

## 2. DSH 侧能力核实

### 2.1 已核实（可作为设计前提）

| 需求 | 机制 | 证据 |
|---|---|---|
| 持久安装 | bundle 包 + `dsh.bundle.patch` + `plugin_manager install_bundle` | `references/plugin-development.md`、`host-plugin.md` |
| 给 agent 加工具 | `ctx.tools.register(definition)`，定义就是普通对象 | `dsh-tools/src/schema.ts:555-633`（`defineTool` 返回 `ToolDefinition` 字面量） |
| 参数 schema 形态 | `parameters` = `{type:'object', properties, required}`（**不是** DSL） | `dsh-tools/src/schema.ts:450-459` |
| 长任务 + 进度 | `ctx.jobs.start({kind,label,owner,run(job)})`；`job.updateProgress('OCR 240/720')`、`job.append(text)`；`ctx.jobs.wait(id,ms,owner)` / `kill` | `dsh-jobs/src/index.ts:114-189`、`types.ts:139-213` |
| 进度 UI（白送） | 已有 jobs 面板：会话语头作业列表 + 流式记录面板 | `packages.md` 中 `@deepseek-ai/dsh-client-ui-jobs` |
| 浏览器↔Host 数据 | `ctx.webServer.register({path, handler})`（任意方法）或 `{resource}`（GET/HEAD）；精确匹配 → 最长前缀 → fallback | `dsh-host-webserver/README.md:61-63` |
| UI 落点 | `tool.call.toolview`（**按工具名 keyed，开放 key 域**）；备选 `sidebar.footer.action` + `shell.overlay`、`settings.section` | `cordis_inspect_query(Slots.listSubTree)` 实测目录 |
| 配置 | 行里的 `config:` 直接作为 `apply(ctx, config)` 第二参数；`export const Config` 可选（不写就自己校验） | `host-plugin.md:62-66` |
| 会话工作目录 | `ctx.workingDirectory.get(session)` | Inspect `Service.listService` |

### 2.2 已核实但要注意的限制

- **工具超时是声明式的**：`timeoutMs` 只是元数据，registry 不强制执行（`dsh-tools` README 的限制章节）；
  但 composition 里可能挂着 `dsh-tool-call-timeout-policy` 给每次调用装 deadline。→ **工具不要一口气阻塞到出片**。
- **`job.start()` 需要已挂载 controller**（`dsh-tool-jobs`）。本 profile 有 `job_*` 工具，说明满足；
  但插件仍应在 `inject` 里声明 `jobs`，缺失时降级为同步执行。
- **插件跑在 Host 进程内，不受 bash/PowerShell 沙箱约束**：写文件、起进程都是进程权限。
  → 越权风险要插件自己兜（见 §6.6）。
- **Client 插件不许 import Harness 的 UI 包**，只能拿 `require('react')` + 自己写控件；样式只用 `--dsw-alias-*` 变量。
- **改了 Host 代码需要重启**（同一包名替换要新模块代），Client 有 HMR 但依赖 `pnpm run dev:web` 观察器。

### 2.3 未核实 / 走不通的路（影响方案取舍）

| 项 | 状态 | 影响 / 对策 |
|---|---|---|
| 自定义 `@Remote` 命名空间（Client 直接调插件服务） | **走不通**：需要 typert 代码生成（包里带 `lib/typert.remote-client.js`），源码构建工具链不在安装版里 | 改用 `ctx.webServer` 路由，Client 侧 `fetch` 同源地址 |
| `cordis_inspect_query` 的 `input` | 本会话实测被拒：`"input" must be an object`（传对象和 JSON 字符串都一样） | Slot props 契约只能读源码（`dsh-client-ui-tool/src`）确认，或在页面上实测 |
| Client 侧 `fetch` 在 Desktop 下的可用性 | 未验证。页面是同机回环地址（端口随启动变化，应同源可用）；README 提到 Electron 有 `file://` + IPC 桥的形态 | M2 第一步先写一个"health"路由 + 按钮点一下验证 |
| `tool.call.toolview` 的 props 形状 | 未拿到（受上一条连累） | 备选方案：`sidebar.footer.action` 按钮 + `shell.overlay` 面板（两个注册在同一个 client 模块内用闭包共享状态，完全可控） |

## 3. 目标形态

**主路径（对话式）**

> 你：把最近一条回放剪一下
> → 工具 `auto_reel` 起作业，卡片实时显示 `OCR 240/720`、`切片 2/4`
> → 出片后卡片变成：6 次击杀表 + 4 段区间 + `<video>` 播放器 + 「打开目录」

**次路径（M3，作品库）**：侧栏/设置页列出 `out/*` 的历史成片，点开即播，支持重剪。

架构：

```
┌─ Browser ────────────────────────────────┐
│ client.js  tool card / panel (React)     │
│      │ fetch /autoreel/api/*         │
└──────┼───────────────────────────────────┘
       │ HTTP (loopback)
┌──────▼─ Host (plugin index.js) ──────────┐
│ tool: auto_reel   job: auto-reel │
│ routes: api + media(Range)               │
│        │ spawn                            │
│        ▼                                  │
│  node scripts/highlight.mjs（默认）          │
│  └ pwsh scripts/highlight.ps1 -Machine（回落）│
│    ├─ ffmpeg 抽帧/切片/拼接               │
│    └─ kfocr.exe (batch 60)                │
└────────┬─────────────────────────────────┘
         ▼
   out/<素材名>/highlight_reel.mp4
```

## 4. 包布局

```
D:\AIworks\AutoReel\plugin\        # = bundle 包 @local/auto-reel
├─ package.json          # dsh.bundle.patch + dsh.client + exports(locale/icon)
├─ cordis.patch.yml      # insert 一行 host plugin
├─ index.js              # Host: tools + jobs + webServer routes + 设置读写（配置合并在本文件）
├─ lib/
│  ├─ engine.js          # 选引擎、拼命令行、spawn、解析 `HC <json>`、取消
│  ├─ http.js            # JSON body、MIME、Range（206）、静态服务
│  └─ replays.js         # 回放目录扫描、素材名归一化、作品库列举
├─ client.js             # Client: 工具卡片 + 右侧栏面板（进度轮询 + 表格 + player）
├─ locale/{en,zh}.json   # meta.title / meta.description / UI 文案
├─ docs/DETAIL.md        # 插件详情页（能力、用法、限制）
└─ icon.svg
```

（比原草案少了 `lib/config.js`、`lib/media.js`、`docs/preview.svg`：配置合并留在 `index.js`，
Range 并入 `lib/http.js`，预览图用 `icon.svg`。）

`package.json` 关键字段（其余照 `templates/decoration`）：

```json
{
  "name": "@local/auto-reel",
  "version": "0.1.0", "private": true, "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true,
                "inject": ["@deepseek-ai/dsh-client-ui-tool"] }
  }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: auto-reel
      name: '@local/auto-reel'
      config:
        replaysDir: '%USERPROFILE%\Videos\VALORANT'
```

## 5. 接口草案

> 本节是 M1 的设计稿。落地差异：开关定名 `-Machine`（§0.5 坑 1）、`dryRun` 未实现；
> 路由与配置项已按实际实现更新在 §5.3 / §5.4。

### 5.1 工具 `auto_reel`

| 参数 | 类型 | 说明 |
|---|---|---|
| `source` | string? | 回放路径；省略或 `latest` = `replaysDir` 里 mtime 最新的一条 |
| `localId` | string? | 默认 `auto`（沿用黄框推断）；判不出来时工具返回明确错误要求显式指定 |
| `roi` | string? | 击杀条 ROI `"x,w,h,y1,y2,y3"`（源视频像素）；默认 `auto` = 按分辨率相对 1440p 等比缩放、贴右边缘（后来补的参数，见 README） |
| `dryRun` | boolean? | 只 OCR + 判定，不编码（调试/预览击杀表，~37s）。**未实现** |
| `waitSeconds` | number? | 阻塞等待上限，默认 45；超时返回 job id，让 agent 继续（同 bash 后台作业语义） |

返回（文本）：`job` / `status` / `kills[]`（t、text、slot、score）/ `segments[]`（start、end）/ `output` 路径。

注册代码形态（**不 import 任何包**）：

```js
ctx.tools.register({
  name: 'auto_reel',
  description: '从 NVIDIA 即时回放里按击杀信息栏 OCR 自动剪出击杀集锦，返回成片路径与击杀/分段明细。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '回放文件路径；省略则用最新一条' },
      localId: { type: 'string', description: '本机玩家 ID，默认 auto' },
      dryRun: { type: 'boolean', description: '只识别不剪辑' },
      waitSeconds: { type: 'number', description: '阻塞等待上限，默认 45' },
    },
    required: [],
  },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  async execute(args, exec) { /* enqueue → job → wait */ },
})
```

### 5.2 后台作业

```js
const id = ctx.jobs.start({
  kind: 'auto-reel',
  label: `auto-reel ${path.basename(source)}`,
  owner: session.id,
  run(job) {
    const child = spawnEngine(source, {
      onStage: (s, pct, text) => job.updateProgress(`${s} ${pct}% ${text}`),
      onLine:  line => job.append(line + '\n'),
    })
    return { cancel: () => child.kill(), done: child.finished }  // JobOutcome
  },
})
```

### 5.3 HTTP 路由（`/autoreel` 前缀，实际实现）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/autoreel/api/health` | 逐项自检：ffmpeg / 引擎脚本 / kfocr / 模型 / node / pwsh / 回放目录 / 目录选择器 |
| GET | `/autoreel/api/replays?dir=` | 回放列表（名字、大小、mtime；`dir` 可临时覆盖已存设置） |
| GET/POST | `/autoreel/api/settings` | 读/写面板设置，落盘 `%LOCALAPPDATA%\AutoReel\settings.json` |
| POST | `/autoreel/api/cut` | `{source?, replaysDir?, outputDir?, pre?, post?, roi?}` → `{id, run}`；与面板同一条执行路径 |
| POST | `/autoreel/api/pick-dir` | 弹系统目录对话框（`ctx.directoryPicker`，非本机桌面时返回 400） |
| GET | `/autoreel/api/runs/latest` | 最近一次 run |
| GET | `/autoreel/api/runs/<id>` | 状态 + 进度 + 结果（prefix 路由） |
| GET | `/autoreel/api/library` | 成片列表（带 `mediaUrl`），扫 `out/` |
| POST | `/autoreel/api/reveal` | `explorer /select` 打开目录，载荷 `{stem}` 或 `{id}` |
| GET | `/autoreel/api/client-graph` | 诊断：client 模块有没有进启动图 |
| GET | `/autoreel/media/<素材名>/highlight_reel.mp4` | 成片，支持 `Range`（206）；50 MB 级文件必须能 seek |
| GET | `/autoreel/media/run/<id>/highlight_reel.mp4` | 面板刚剪完、输出目录还没保存时的成片 |

取消没有单独的 kill 路由：模型侧用作业的 `job_kill`，面板侧直接丢弃本地 run id。

### 5.4 配置（实际实现）

`replaysDir`、`sourcePath`（空 = 每次取最新）、`outputDir`、`engine`(`auto|js|ps`)、`scriptPath`（ps 回落引擎）、
`engineScript`（js 引擎）、`nodePath`、`ocrExe`、`modelsDir`、`pwshPath`、`scanFps`(2)、`chunkSize`(60)、
`waitSeconds`(45)、`localId`(`auto`)、`pre`(3.5)、`post`(1.5)、`keepWork`(false)。

路径探测顺序：配置 → 环境变量（`TACK_OCR_MODELS`）→ 包内路径（`<包>/engine`、`<包>/bin`、`<包>/models`）
→ 仓库相对路径（`<repo>/scripts`、`<repo>/kfocr`、`D:\AIworks\Tack\...`）→ PATH。

面板可改的五项（`replaysDir` / `sourcePath` / `outputDir` / `pre` / `post`）另存到
`%LOCALAPPDATA%\AutoReel\settings.json`，覆盖 patch 里的默认值，保存即时生效、不用重启。

## 6. 关键取舍

### 6.1 引擎边界：三选

| 方案 | 做法 | 工作量 | 优点 | 代价 |
|---|---|---|---|---|
| **A（M1 采用，现作回落）** | spawn `highlight.ps1 -Machine` | 小（脚本 +20 行） | 复用已跑通、已测过 bug 的实现；当天就能出片 | 依赖 pwsh 7；进度粒度受脚本限制；逻辑在 PS 里 |
| **B（M3，已实施）** | 判定逻辑 JS 化，ffmpeg/kfocr 仍 spawn | 中（~400 行 + 金样测试） | 去掉 pwsh；进度/取消更细；可在 CI 里单测 | 需要 PNG 像素采样（本机用 `kfocr --marker` 在 Rust 里顺手算）；有 parity 风险 |
| **C（不建议先做）** | 给 kfocr 加 `cut` 子命令，全流程 Rust | 大 | 单进程、最快、最适合分发 | 胶水代码多，调试成本高 |

理由：判定逻辑是这个项目唯一"有知识"的部分，也是最容易回归的部分。**先让它只有一份实现**，
用 PS 跑通整条链路；等插件形态稳定、真的需要脱离 PowerShell 时，再按金样测试迁移（B）。

### 6.2 进度与超时

不把工具做成"一次调用等到出片"：120s 素材已经 58s，长回放会到几分钟，撞上 tool-call deadline 就白跑。
统一 **start job → wait ≤ 45s → 返回 job id**；agent 用 `job_output` 收尾，用户看 jobs 面板的实时进度。
这让"进度"变成三种消费者共用的一个事实源：模型、jobs 面板、工具卡片。

### 6.3 UI 落点：工具卡片优先

`tool.call.toolview` 按工具名注册，正好落在"事情发生的地方"，且卡片本身有 pending 态可以轮询进度。
不引入新导航、不需要自定义 Remote。若实现时发现该 slot 的 props 不含结果内容，
退回 **footer 按钮 + `shell.overlay` 面板**（两次注册共享一个模块内的状态，不依赖宿主契约）。

### 6.4 媒体分发：自建 Range 路由

50 MB 的 mp4 必须支持 `Range` 才能拖动进度条；`<video src="/autoreel/media/x.mp4">` 直接播，
不需要把字节塞进 Remote 或附件系统。

### 6.5 二进制与模型

仓库里的开发版不打包（bundle 保持可读的 JS），默认路径解析成"包内优先、仓库回落"：
`<包>/engine`、`<包>/bin`、`<包>/models` 存在就用，否则退回 `<repo>/scripts`、`<repo>/kfocr`、
`D:\AIworks\Tack\...`。分发包由 `scripts/build-plugin.ps1` 产出，**自带** `bin/kfocr.exe`（5.3 MB）
与 `models/`（31 MB），解包后只依赖系统的 `ffmpeg` 9（Node 由 DSH 自带；`pwsh` 7 仅 `engine: ps`
或 auto 回落时需要）。ffmpeg 单文件 212 MB，
不进包；市场化的依赖策略见 §10。

### 6.6 权限与沙箱

插件在 Host 进程内，沙箱不拦。自己立三条规矩：

1. 输出默认只写 workspace 下的 `out/`，越界路径直接报错（除非配置显式放开）；
2. 源文件只读，不移动不删除；
3. 路由只服务本机：校验 `Origin`/`Host` 等于 `ctx.webServer.getOrigin()`，只读媒体路由允许 `Range`。

### 6.7 并发

OCR 吃满 CPU，ffmpeg 也是。单 worker 串行队列（`maxConcurrent: 1`），队列里同源请求合并；
第二次请求返回"正在跑，job id 是 …"。

## 7. 分阶段计划

| 阶段 | 内容 | 验收（必须实测） |
|---|---|---|
| **M0** | 给 `highlight.ps1` 加 `-Events`（最终定名 `-Machine`）：stdout 只输出 `HC\t<json>` 行，人读信息走 stderr | 命令行跑一条素材，事件行完整；`out/` 产物与现在逐字节一致 |
| **M1** | bundle 骨架 + `auto_reel` + 作业 + 路由（health/replays/cut/jobs/media）+ locale/icon/DETAIL；安装 | 新会话里说"剪最近一条回放"→ 出片；jobs 面板有进度；`job_kill` 能中断；卡片/工具结果路径正确 |
| **M2** | client.js 工具卡片：进度轮询、击杀表、`<video>`、打开目录；locale 中英；图标与详情图 | 刷新页面后卡片可播可拖；中英文案正确；dispose 后无残留定时器 |
| **M3（可选）** | 作品库页（`settings.section` 或 overlay）+ `/cut` 命令 + 判定逻辑 JS 化 + 金样测试 | 6 条素材重跑，击杀/分段与 PS 版逐条一致（**JS 化与金样已完成**，见 §0.5/§11.4；余作品库页与 `/cut`） |

## 8. 风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| `tool.call.toolview` props 契约未确认 | M2 卡片拿不到结果 | 先读 `dsh-client-ui-tool/src`；不行就退回 footer+overlay |
| Desktop 下 client `fetch` 形态不确定 | UI 拿不到数据 | M2 第一件事做 `health` 自检；退路是用 boot payload 里的 host origin 拼绝对 URL |
| `job.start()` 依赖 controller | 插件在别的 profile 里静默失效 | `inject: ['tools','jobs']`；无 jobs 时降级同步执行 |
| pwsh / ffmpeg / kfocr 路径漂移 | 出片失败 | 启动时自检（`/health` 返回三项检查结果），错误信息指名缺哪个 |
| OCR 模型要再分发 | 许可证/体积 | 分发包自带 `models/`（31 MB）；**公开分发前须确认上游许可证**，不行就发 `-NoModels` 版并让用户配 `modelsDir` |
| pwsh 无法从 npm 获得 | 市场分发受阻 | **已根治**：插件默认引擎是 JS（`engine: auto` → js），只剩 ps 回落才需要 pwsh |
| 与 tool-call 超时策略冲突 | 长任务被杀 | 作业 + 有界等待；wait 用 `exec.signal` 联动取消 |
| 同屏 4+ 杀漏检（槽位固定 3） | 成片少一段 | 槽位目前写死 3 个（`lib/roi.mjs`）；扩到 5 格要改代码，OCR 次数 720 → 1200（约 +67%），DETAIL 里写明代价 |
| Host 改动需重启 | 迭代慢 | M1 阶段接受重启；Client 侧靠 HMR |

## 9. 需要拍板（已拍板，见 §0.5 的实施状态）

1. **引擎边界**：M1 走 A（包 PowerShell）还是直接上 B（JS 重写判定）？建议 A。
2. **首版 UI**：工具卡片 / 侧栏面板 / 设置页？建议工具卡片（M2 再做作品库）。
3. **回放默认目录**：`%USERPROFILE%\Videos\VALORANT` 对不对？（NVIDIA 即时回放按游戏名建子目录）
4. 是否保留 `-LocalId auto` 作默认，还是首版就强制显式指定（减少一次"判不出来"的失败）。

实际选择：工具卡片 + `%USERPROFILE%\Videos\VALORANT` + 保留 `auto`；引擎 M1/M2 走 A（包 PowerShell），
M3-B 落地后默认切 B（`engine: auto` → js，A 作回落）。

---

## 10. 分发与依赖策略

目标：别人装了就能用，且不需要"首次运行时由 agent 临时下载"。

### 10.1 结论：不要在运行时下载，把依赖前移到安装期

| 依赖 | 渠道 | 用户操作 |
|---|---|---|
| ffmpeg / ffprobe | **npm 依赖**（`@ffmpeg-installer/ffmpeg`） | 无 —— 装插件时 pnpm 一起装好 |
| kfocr.exe | 插件包内 `bin/` | 无 |
| OCR 模型 | 插件包内 `models/` | 无（许可证需确认，见 §8 风险） |
| PowerShell 7 | **已从默认路径去掉**（默认引擎 js；仅 `engine: ps` 或 auto 回落时需要） | 无 |

为什么不走"agent 首次运行下载"：

1. **pwsh 没有官方 npm 包**，这条路对 ffmpeg 之外不成立；
2. 200 MB 级下载由模型临时决定，用户看到的是一段无反馈的等待，失败了也说不清卡在哪；
3. 市场审核最容易拒的就是"自动下载并执行未固定校验和的二进制"；
4. 每次下载的版本/架构可能不同，问题不可复现。

### 10.2 ffmpeg 具体选型

| 包 | 二进制来源 | 是否需要安装脚本审批 |
|---|---|---|
| `@ffmpeg-installer/ffmpeg` ✅ | 平台子包**直接打包二进制**（win32-x64 约 40–65 MB），无 postinstall | 不需要 |
| `ffmpeg-static` ❌ | postinstall 去 GitHub 下载 | 需要（`approvedBuilds`），代理/CI 下常失败 |

插件侧：解析依赖导出的 `.path`，解析不到再回落 PATH（尊重用户已有的 ffmpeg）。

### 10.3 首次运行该做什么

由**插件代码**做确定性引导，而不是让 agent 自由发挥：

- `/autoreel/api/health` 逐项点名缺什么（已实现）；
- 卡片给出可操作提示：缺 ffmpeg → 显示"安装依赖"按钮，或把 ffmpeg 放进 PATH（引擎按 `ffmpeg` 调用）；
- 真要自动装，就由插件调用 `winget install Gyan.FFmpeg`，或下载**固定 URL + 固定 sha256**
  的包到 `%LOCALAPPDATA%\AutoReel\bin`，用户点一次同意——可审计、可复现。

### 10.4 允许 agent 参与的唯一形态

用户显式触发：工具失败时返回"缺少 ffmpeg：可以让我执行 `winget install Gyan.FFmpeg`"，
用户说"装吧"，agent 再用 pwsh 工具执行。区别是**用户请求 → agent 执行**（有审批、可见），
而不是插件首次运行静默下载。

## 11. 引擎 JS 化可行性（M3-B）

结论：**能，且只有一处要换做法**——像素采样。其余全部是一对一移植。

### 11.1 逐段对照

| 现在（PowerShell） | JS 里怎么做 | 难度 |
|---|---|---|
| ffmpeg 抽帧 / 切片 / concat | `spawn` + 参数数组，完全一致 | ✅ 插件已经在这么做 |
| `kfocr --list` 批量 OCR、解析 TSV、60 张一段 | 一样，流式读 stdout | ✅ |
| `Get-AutoLocalId` 的「行首黄框」判定 | **唯一难点**，见 §11.2 | ⚠️ |
| `Get-LocalKillText`（剥噪声、前缀匹配、CJK 正则） | `/[\u4E00-\u9FFF]/`（固定常用汉字块，见 §11.3） | ✅ |
| `ConvertTo-KillEvents`（分组 + 滑动窗口 + 同屏计数） | `Map` + 排序 + 线性扫描 | ✅ |
| `Merge-VariantEvents`（Levenshtein ≤ 1） | 十几行 DP | ✅ |
| `New-HighlightSegments`（合并 / 钳制重叠） | 纯算术 | ✅ |
| ffprobe 元数据、kills.json、拷贝与清理 | `node:fs` | ✅ |

耗时大头（OCR ≈ 32s、切片 ≈ 8s、抽帧 ≈ 9s）都在外部进程，JS 只做编排，
所以性能不会退化，反而省掉 pwsh 启动与每帧 `System.Drawing` 的开销。

### 11.2 「行首黄框」的三种做法

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 挪进 kfocr**（推荐） | Rust 里已经解码了整张图，加 `--marker` 输出"左 50% 淡黄占比"，约 20 行 | 最快、零新依赖，比现在少一次进程与解码 |
| B. 纯 JS 解码 | 引 `pngjs`（纯 JS，~100 KB）解 760×50 小图 | 可行；只采样有命中的 ~50 张，开销可接受 |
| C. ffmpeg 转 rawvideo | `-f rawvideo -pix_fmt rgb24 -` 再按字节解析 | 每次起进程，最慢，不推荐 |

### 11.3 会咬人的语义差异

1. **取整**：PS `[math]::Round` 是银行家舍入（.5 进偶数），JS `Math.round` 是 .5 进位。
   时间戳差 0.01s 或槽位差 1px，但金样比对会报出来。
2. **正则**：不能直接用 `\p{Unified_Ideograph}` 对齐——.NET 的 `\p{IsCJKUnifiedIdeographs}`
   只是 U+4E00–9FFF 这个块，而 Unicode 的 `Unified_Ideograph` 还含扩展区与部首兼容字；
   JS 侧固定用 `/[\u4E00-\u9FFF]/`，两边剥噪声的结果才一致（`Script=Han` 范围更宽，更不能用）。
3. **字符串下标**：都是 UTF-16 code unit，BMP 汉字一致；代理对（emoji、生僻字）两边都
   "按半个字"处理，不是退化。

### 11.4 迁移策略与成本

**双引擎并存**，配置项 `engine: auto | js | ps`（默认 `auto`：js 优先，异常回落 ps）。

验收：现有 6 条素材 + `scripts/test-events.ps1` 的 10 个合成用例，
JS 版的 `kills` / `segments` 必须与 PS 版逐条一致，全绿再默认切 js。

成本约 **1.5–2 天**：

| 步骤 | 内容 | 估时 | 状态 |
|---|---|---|---|
| 1 | kfocr 加 `--marker` | 半天 | ✅ 已实现；206 张图与 System.Drawing 数值差 0 |
| 2 | 事件逻辑移植 + 金样测试 | 1 天 | ✅ `lib/events.mjs` + 48 项合成用例；6 条素材逐条一致 |
| 3 | 编排层（抽帧/OCR/切片/concat）替换 | 半天 | ✅ `scripts/highlight.mjs`；成片 SHA256 与 PS 版相同 |
| 4 | 默认切 js，保留 ps 回落 | 半天 | ✅ 已改（`engine: auto`，插件 Host 半）；2026-11-18 重启后实测 `engine: js`，成片与金样 SHA256 一致 |

实测两个坑（原表 §11.3 只列了现象，这里是落地时的具体值）：

- **取整**：1080p `230 × 0.75 = 172.5`，PS 得 **172**、`Math.round` 得 **173**。
  统一用 `lib/round.mjs` 的 `psRound`（.5 进偶数）；`test-events.mjs` 里有 1080p ROI 的回归用例。
- **沙箱里的子进程**：DSH workspace-write 下 Node `stdio:'pipe'` 直接 EPERM；
  `lib/proc.mjs` 改为临时文件重定向，沙箱内外都能跑。

**收益**：分发只差 ffmpeg（npm 装）→ 真正"装完即用"；可单测；进度/取消更细；跨平台。

---


