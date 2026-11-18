# 公开仓库与插件分发：待办清单

> 盘点时间 2026-11-18。前提：**Tack 是作者自研、尚未完成、也未公开的项目**。
> 本文只记录"还差什么、为什么、怎么做"，不重复 README 里的使用说明。

## 0. 结论

- 仓库现在**可以公开，并且源码可构建**：`kfocr` 不再依赖外部 Tack，`cargo build --release` 直接过。
- 已完成的兜底：Tack 是作者自研、尚未完成、未公开的项目 → 只把 `tack-ocr` 与 19 KB 的
  `punct` 模块 vendor 进 [`third_party/`](../third_party)（约 200 KB），Tack 本身不公开。
- **剩下的阻塞只有一件**：OCR 模型权重的再分发许可未最终确认（§2.2），
  其余是发布动作与仓库卫生（§3、§4）。

## 1. 已经就绪

| 项 | 状态 |
|---|---|
| [LICENSE](../LICENSE) | MIT，与 `build-plugin.ps1` 打进包里的那份一致 |
| [.gitignore](../.gitignore) | 排除 `out/`、`dist/`、`kfocr/target/`、`node_modules`、`.env`、`*.bak-*` |
| [.gitattributes](../.gitattributes) | 文本统一 LF；`mp4/DVR/tgz/exe/rten` 标二进制 |
| [plugin/package.json](../plugin/package.json) | 已补 `license: MIT`、`engines.dsh: ^0.2.2-rc.3`（安装时会检查） |
| [docs/parity-report.json](parity-report.json) | 金样比对报告入库，README 不再引用不入库的 `out/_parity/` |
| [README](../README.md#L367) | 补了「四种安装写法」「仓库里不放什么」「公开仓库的已知限制」 |
| [scripts/build-plugin.ps1](../scripts/build-plugin.ps1) | 能产出自包含 tgz（engine + `bin/kfocr.exe` + `models/`，约 27 MB） |
| [third_party/](../third_party/README.md) | Tack 源码最小快照（`tack-ocr` + `punct`），双许可全文随目录，同步步骤写在 README |
| [THIRD_PARTY.md](../THIRD_PARTY.md) | 第三方组件与许可登记：代码快照、模型 SHA256、依赖清单 |
| 本地 git | 已 `init -b main`，文件已暂存，**尚未 commit** |
| 安装器事实 | `install_bundle` 接受 4 类 spec：registry / 绝对路径 / git 地址 / tarball（含 http URL）；装后会检查 `engines.dsh` |

## 2. 源码可构建（已完成）

原来的阻塞：[kfocr/Cargo.toml](../kfocr/Cargo.toml) 用 `path = "D:/AIworks/Tack/..."`，
而 Tack 是作者自己还在开发、**未完成也未公开**的项目，外部既 clone 不到、也拿不到那两个 crate。

四个备选里选了 **B（vendor 最小集）**，2026-11-18 已落地并验证：

| 项 | 结果 |
|---|---|
| [`third_party/tack-ocr`](../third_party/tack-ocr) | 原样拷贝 5 个 `.rs`（4789 行 / 181 KB），只重写 `Cargo.toml`（上游用 workspace 继承，这里内联版本号） |
| [`third_party/tack-core`](../third_party/tack-core) | 3 行 `lib.rs` + 原样 `punct.rs`（491 行 / 19 KB）。`tack-ocr` 只用到 `tack_core::punct` 的 6 个函数，整包 23.7k 行的其余模块与 OCR 无关，没有搬；crate 名不变，`tack-ocr` 里的调用一行没改 |
| 许可 | `third_party/LICENSE-MIT`、`third_party/LICENSE-APACHE`（Tack 是 MIT OR Apache-2.0 双许可） |
| 构建 | `cargo build --release --offline` 通过，**1m43s** |
| 端到端 | 89 MB 素材 → 3 杀 / 2 段 / 14.2 MB，成片 SHA256 `AA683EAD…`，与 [金样](parity-report.json) **逐字节一致** |
| 代价 | 仓库多约 200 KB / 5.3k 行；上游改动要手动同步（步骤见 [third_party/README.md](../third_party/README.md)） |

没选的三个：A（开源 Tack）等 Tack 做完再说；C（只发预编译）不再需要；D（重写 OCR）3–5 天不划算。

**以后 Tack 做完了**：删掉 `third_party/`，`kfocr/Cargo.toml` 换回外部依赖，`kfocr` 代码不用动：

```toml
tack-ocr  = { git = "https://github.com/Yur1Chen/Tack", rev = "<远端已推送的 40 位提交>" }
tack-core = { git = "https://github.com/Yur1Chen/Tack", rev = "<同一个提交>" }
```

切换时**必须 pin 到远端已推送的提交**——试过用本地 HEAD `9401a231…`，cargo 报
`upload-pack: not our ref`，就是因为那个提交还没推上去。

### 2.1 模型目录不再写死（已完成）

原来 [kfocr/src/main.rs](../kfocr/src/main.rs) 里有一行
`const DEFAULT_MODELS = r"D:\AIworks\Tack\target\release\models";`，对外的机器会直接落到一个不存在的路径。

2026-11-18 已改成"没有就报错并提示"，并把链路补齐：

| 位置 | 现在的行为 |
|---|---|
| `kfocr` | `--models` → `TACK_OCR_MODELS` → 报错（空字符串也当成没设）；目录不存在也报错并退出 2 |
| `scripts/highlight.mjs` | 新增 `--models`，默认读 `TACK_OCR_MODELS`，缺了在起 ffmpeg 之前就报错；OCR 调用都带 `--models` |
| `scripts/highlight.ps1` | 新增 `-Models`（默认 `$env:TACK_OCR_MODELS`），缺了抛错；两处 kfocr 调用都带 `--models` |
| `plugin/index.js` | 去掉了指向作者机器的回落（`<repo>/../Tack/...`），只认配置 `modelsDir` / 环境变量 / 包内 `models/` |
| 文档 | README 用法一节说明"先设 `TACK_OCR_MODELS`"；DETAIL 的依赖表同步 |

验证（同一条 89 MB 素材，成片要与金样 `AA683EAD…` 一致）：

- `kfocr` 不带模型：报 `找不到 OCR 模型目录…`，退出码 2；`--models D:\nope`：报"目录不存在"；
- `highlight.mjs` 不传模型：报错退出 1；用环境变量：3 杀 / 2 段 / SHA256 与金样一致；
- `highlight.ps1 -Models <目录>`：同样 3 杀 / 2 段 / SHA256 一致。

### 2.2 OCR 模型的再分发许可（已确认）

`det.rten`（9.9 MB）/ `rec.rten`（21.2 MB）/ `ppocrv6_dict.txt`（75 KB）来自 **PP-OCRv6 Small**
（PaddleOCR v3.7.0，2026-06-11 发布），权重许可为 **Apache-2.0**——2026-11-18 核实，依据与链接见
[THIRD_PARTY.md](../THIRD_PARTY.md) §2（官方模型卡 licence 徽章、PaddleOCR LICENSE、官方讨论区答复、
第三方同类转换件的处理方式）。

`.rten` 属于 Apache-2.0 允许的衍生格式，需要履行：

- 包内附 Apache-2.0 全文；
- 附 NOTICE（上游版权 + 我们做的修改：转成 `.rten`）；
- 不暗示上游背书。

`build-plugin.ps1` 已按此实现（含模型时自动带 `LICENSE-APACHE` / `NOTICE` / `THIRD_PARTY.md`）；
不想带模型仍可用 `-NoModels`（实测 2.2 MB）。

### 2.3 二进制怎么给

`bin/kfocr.exe`（5.5 MB）现在只存在于 `dist/`（不入库）。三种给法：

| 方式 | 说明 | 依赖 |
|---|---|---|
| Release 资产（推荐） | 每个 tag 附一个 `auto-reel-<ver>.tgz`，内含 exe 与模型 | 无 |
| Git LFS | 让 `git` 地址直装也能跑 | 用户装 git-lfs；pnpm 走 LFS 不稳 |
| CI 构建 | 每个 tag 在 Actions 里 `cargo build --release` 后打包 | 已无阻塞（源码可构建），`third_party/` 已入库 |

## 3. 从仓库地址装插件：三条路

`install_bundle` 的解析器只认四类 spec（见 `@deepseek-ai/dsh-plugin-manager` 的 `install-spec`）：
`registry` / 绝对路径 `path` / `git` 地址 / `tarball`（本地或 http(s)）。

**A. Release 资产 URL —— 推荐，也是"填地址即装"的唯一稳做法**

1. 打 tag 前先跑 `pwsh scripts/build-plugin.ps1`；
2. 把 `dist/auto-reel-<ver>.tgz` 传成 Release 资产，**同时传一份改名成 `auto-reel.tgz`**；
3. 用户填：`https://github.com/Yur1Chen/AutoReel/releases/latest/download/auto-reel.tgz`。

包是自包含的（engine + exe + models），装完 `/autoreel/api/health` 全绿。
这条路**当前就能用**，不依赖 §2 的任何改动。

**B. git 地址直装 —— 只适合开发者**

- 形式：`github:Yur1Chen/AutoReel#<40 位提交>&path:/plugin`（管理器认 `path:` 子目录片段）。
- 障碍：装进 profile 的只有 `plugin/`，里面没有 `engine/`、`bin/`、`models/`；
  而 [plugin/index.js:68](../plugin/index.js#L68) 的回落是 `<包>/../scripts`，安装后指向
  `node_modules/@local`，不存在 → health 的 `script`/`ocr`/`models` 三项会红。
- 要用这条路，得先解决 §2.3（把 exe/模型塞进包内），建议不折腾。

**C. npm registry**

- 去掉 `plugin/package.json` 的 `private`，包名换成真实 scope（`@local` 发不了 npm）；
- 决定发 27 MB（含模型）还是 2.2 MB（`-NoModels`）；
- 用户填 `@yourscope/auto-reel@0.1.0`，还自带更新检查。

三条路共同前提（已完成）：`dsh.bundle.patch` 存在、`engines.dsh` 已声明、`files` 覆盖运行时文件。

## 4. 仓库卫生

### 已完成

- **CI**：[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) —— windows-latest，两个 job：
  `js-tests` 跑 `test-events` / `test-host` / `test-client`（不依赖录像与 OCR），
  `kfocr-build` 用 `cargo build --release` 证明源码可构建并上传 `kfocr.exe` 产物。
- **版本**：全仓统一 `0.1.0`（package.json / `plugin/index.js` 的 `VERSION` / 打包脚本）。

### 还要做

- **首图**：README 加一张工具卡片或面板截图（现在全是文字；本机没有浏览器截图能力，需要你自己截）。
- **元数据**：`plugin/package.json` 补 `repository` / `homepage` / `bugs`；GitHub 侧填描述与 Topics。
- **SECURITY.md**：插件在本机开了 `/autoreel/*` HTTP 路由，只校验来源、不鉴权，需要显式写明。
- **隐私**：`out/` 已排除；README 金样表里有真实玩家 ID（`乐邦詹士` 等），要更保守可脱敏。
- **示例路径**：README/PLAN 里多处 `D:\AIworks\...` 是作者机器路径，建议标注"示例"或换成
  `<你的目录>`。

### 已知坑

**从 `link:` 安装换成 tgz / Release URL 时，pnpm 会顺着 junction 删掉链接目标的内容。**
2026-11-18 实测：把 profile 的 `link:D:/AIworks/AutoReel/plugin` 换成 Release URL 后，
仓库里的 `plugin/` 被清空（11 个文件全没），`git restore -- plugin` 才恢复。
换装前先 `git status` 确认干净（或备份），或者在换装前先 `remove_bundle`。

### 发布清单（本机执行）
```powershell
# 1. 确认工作区干净、测试通过
node scripts\test-events.mjs; node scripts\test-host.mjs; node scripts\test-client.mjs

# 2. 打包（需要模型目录；没有就加 -NoModels）
pwsh scripts\build-plugin.ps1                 # → dist/auto-reel-0.1.0.tgz（27.1 MB）

# 3. 提交 + 打标签
git add -A; git commit -m "release: v0.1.0"
git tag v0.1.0
git push origin main --tags

# 4. 在 GitHub 建 Release（v0.1.0），上传两个资产：
#    dist/auto-reel-0.1.0.tgz
#    同一份复制成 auto-reel.tgz   ← 让 /releases/latest/download/auto-reel.tgz 成为稳定地址

# 5. 验证"填地址即装"
#    插件页 → 添加插件 → https://github.com/Yur1Chen/AutoReel/releases/latest/download/auto-reel.tgz
#    装完看 /autoreel/api/health 是否全绿，再真剪一条
```

## 5. 需要拍板

1. ~~Tack 怎么办~~ **已定**：走 B（vendor 最小集），源码已可构建（§2）；A 等 Tack 成熟后切换。
2. ~~模型能不能随包再分发~~ **已确认**：PP-OCRv6 Small 权重是 Apache-2.0，可随包分发；
   打包自动带 `LICENSE-APACHE` / `NOTICE` / `THIRD_PARTY.md`（§2.2）。
3. **发不发 npm**：发 → `private` 去掉、真实 scope；不发 → 只走 Release（§3C）。
4. **接受 Windows-only 吗**：当前实现依赖 `explorer`、`.exe`、`%LOCALAPPDATA%`。
5. **仓库坐标**：`Yur1Chen/AutoReel` 已定，`repository` 字段已填 `repository` 字段与 README 里的示例 URL。

## 6. 建议顺序

| 天 | 内容 |
|---|---|
| D1 | ~~vendor Tack 最小集~~ **已完成**：`third_party/` + 依赖切换 + 构建 1m43s + 金样 SHA256 一致（§2） |
| D2 | ~~确认模型许可~~ **已完成**（Apache-2.0，见 §2.2）；剩下：模型目录不再写死（§2.1）+ 重建 + 金样复验 |
| D3 | ~~CI~~ **已完成**；剩下：首图、元数据、`SECURITY.md`（§4）；打 tag、传 Release（§3A） |
| D4 | 验证"从 Release URL 安装"全流程（health 全绿 + 真剪一条），README 收尾 |

## 附：本次已验证的事实

- `install_bundle` 的 spec 只有 registry / path / git / tarball 四类；http(s) 且以
  `.tgz`/`.tar.gz` 结尾才会被当成 tarball，**GitHub 的源码归档 `archive/refs/tags/*.tar.gz`
  不算**（里面没有插件包的 `package.json` 结构）。
- 安装时会读 `engines.dsh` 校验 DSH 版本；git/tarball 装完才检查，装的包必须自己声明
  `dsh.bundle.patch`。
- git spec 的固定形式是 `#<40 位提交>&path:/子目录`，且提交必须在远端存在。
- 2026-11-18 实测：受限沙箱里 cargo 无法写 `~/.cargo`、也无法建立 TLS，
  所以**改依赖/拉包这一步需要一次性完全权限**；单纯 `cargo build`（依赖已缓存时）不受影响。
