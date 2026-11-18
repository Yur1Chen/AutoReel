# third_party：从 Tack 拿过来的最小快照

`kfocr` 的 OCR 依赖 Tack（作者的另一个项目）。Tack 目前**未完成、未公开**，所以这里放一份
最小快照，让本仓库 clone 下来就能 `cargo build`；Tack 完成并公开后应当删掉本目录、改回
git/crates.io 依赖（见 [`docs/PUBLISHING.md`](../docs/PUBLISHING.md) §2.1 方案 A）。

## 快照信息

| 项 | 值 |
|---|---|
| 上游仓库 | `D:\AIworks\Tack`（私有，2026-11-18 快照） |
| 上游提交 | `9401a231f8a928e6f79a8ff7d7069abe85a6cf24`（私有仓库的本地提交，外部无法解析，仅作快照标识） |
| 许可证 | MIT OR Apache-2.0（见本目录 `LICENSE-MIT` / `LICENSE-APACHE`） |

## 有什么、没什么

| 目录 | 内容 | 说明 |
|---|---|---|
| `tack-ocr/` | `src/{lib,det,rec,order,preprocess}.rs`，共 4789 行 / 181 KB | 原样拷贝，未改一行代码；`Cargo.toml` 是重写的（上游用 workspace 继承，这里内联版本号），只保留 `rten` / `rten-tensor` / `tack-core` 三个依赖 |
| `tack-core/` | 只有 `src/punct.rs`（491 行 / 19 KB）+ 3 行 `lib.rs` | `tack-ocr` 只用到 `tack_core::punct` 的 6 个函数，整包 23.7k 行里的其余模块（markdown、选句、翻译）与 OCR 无关，没有搬。crate 名字仍叫 `tack-core`，所以 `tack-ocr` 里的 `tack_core::punct::…` 调用不用改 |

**没有搬**：`tack`（GUI 主程序）、`tack-e2e`、`examples/`、`models/`（权重不入库，见仓库根
[THIRD_PARTY.md](../THIRD_PARTY.md)）。

## 同步方式

上游改动后，按下面三步更新（改动只可能落在 `tack-ocr/src` 与 `tack-core/src/punct.rs`）：

```powershell
# 1. 覆盖源码（在仓库根执行）
Copy-Item D:\AIworks\Tack\tack-ocr\src\*.rs third_party\tack-ocr\src\ -Force
Copy-Item D:\AIworks\Tack\tack-core\src\punct.rs third_party\tack-core\src\punct.rs -Force

# 2. 更新上面的"上游提交"
git -C D:\AIworks\Tack rev-parse HEAD

# 3. 重建 + 金样复验（成片 SHA256 必须与 docs/parity-report.json 一致）
cd kfocr; cargo build --release; cd ..
node scripts\highlight.mjs --source '<素材>.DVR.mp4' --release --out out\_sync_check
```

如果上游给 `tack-ocr` 加了新依赖，记得同步 `third_party/tack-ocr/Cargo.toml` 的 `[dependencies]`。

## 切回上游依赖

Tack 公开后，删掉本目录，把 `kfocr/Cargo.toml` 改成：

```toml
tack-ocr  = { git = "https://github.com/Yur1Chen/Tack", rev = "<远端已推送的 40 位提交>" }
tack-core = { git = "https://github.com/Yur1Chen/Tack", rev = "<同一个提交>" }
```

`kfocr/src/main.rs` 不用动（只依赖 `tack_ocr::Engine::load` 与 `recognize_bgra`）。
