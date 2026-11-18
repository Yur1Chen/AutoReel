# 第三方组件与许可

本仓库分发的产物里有三类第三方内容。每一条的许可都已核实（2026-11-18），
履行义务的方式见各节末尾。

## 1. Tack 代码快照（vendored）

| 项 | 值 |
|---|---|
| 位置 | [`third_party/tack-ocr`](third_party/tack-ocr)、[`third_party/tack-core`](third_party/tack-core) |
| 上游 | Tack（作者自有项目，`github.com/Yur1Chen/Tack`，当前私有） |
| 快照提交 | `9401a231f8a928e6f79a8ff7d7069abe85a6cf24`（2026-11-18，私有仓库的本地提交，外部无法解析） |
| 许可证 | **MIT OR Apache-2.0**，全文见 [`third_party/LICENSE-MIT`](third_party/LICENSE-MIT)、[`third_party/LICENSE-APACHE`](third_party/LICENSE-APACHE) |
| 范围 | `tack-ocr` 全量（5 个 `.rs`，4789 行）+ `tack-core::punct`（491 行）；未包含 Tack 的 GUI、e2e、examples |

## 2. OCR 模型权重：PP-OCRv6 Small（Apache-2.0，已核实）

| 文件 | 大小 | SHA256 | 来源 |
|---|---|---|---|
| `det.rten` | 9.9 MB | `7eeeaef1f4315b9b2dfe52e9f2a9f61c55cc2b2e65e16c49b1e46671a2c2b089` | `PP-OCRv6_small_det`，转换为 rten 格式 |
| `rec.rten` | 21.2 MB | `612a150d280c2c162f398aa612e30d98d20b2e58e7a97030b6dc8ed16f5d5f40` | `PP-OCRv6_small_rec`，同上 |
| `ppocrv6_dict.txt` | 75 KB | `b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d` | PP-OCRv6 识别字典 |

**结论：权重是 Apache-2.0，可以随包再分发**（2026-11-18 核实）。依据：

- PP-OCRv6 是 PaddleOCR v3.7.0（2026-06-11）发布的官方模型，分 tiny / small / medium 三档；
- 官方模型卡标注 Apache-2.0：[`PP-OCRv6_small_det`](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det)、
  [`PP-OCRv6_small_rec`](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec)（Hugging Face 上 license 徽章与
  LICENSE 均为 Apache-2.0）；
- PaddleOCR 仓库 [`LICENSE`](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE) 为 Apache-2.0，
  官方在 [Discussion #15986](https://github.com/PaddlePaddle/PaddleOCR/discussions/15986) 明确答复"可商用"；
- 第三方把同一批权重转成 ONNX / LiteRT 再分发时，也按 Apache-2.0 处理并保留上游声明
  （例：[litert-community/PP-OCRv6-Small-LiteRT](https://huggingface.co/litert-community/PP-OCRv6-Small-LiteRT/blob/main/THIRD_PARTY_NOTICES.md)、
  [sonos/tract ppocr 示例](https://github.com/sonos/tract/blob/e31a6d8e19bc0c8df0bbb15411fe781fdb6c21cb/examples/ppocr/web/README.md)）。

`.rten` 是格式转换后的衍生件，Apache-2.0 允许，但要履行 §4 的义务：

1. 附 **Apache-2.0 全文**；
2. 附 **NOTICE**：上游版权（Baidu / PaddlePaddle）与我们的修改（转换为 `.rten`、仅用于文本行识别）；
3. 不得暗示上游对本项目背书。

`pwsh scripts/build-plugin.ps1` 已按此实现：含模型打包时自动带上 `LICENSE-APACHE`、`NOTICE`、
`THIRD_PARTY.md`（`-NoModels` 时只在 `NOTICE` 里说明"不含模型"）。

## 3. 通过 crates.io 依赖的组件

`kfocr` 与 `third_party/tack-ocr` 依赖 `rten` / `rten-tensor` / `image` 等公开 crate，
许可证随各自 crate 分发，不随本仓库再分发源码。构建产物 `kfocr.exe` 因此包含它们的代码，
发行时如需逐项归因，可用 `cargo license` 或 `cargo-deny` 生成清单。

## 4. 不分发的部分

- **ffmpeg**：约 212 MB，仅要求用户在 PATH 中自备，不随包分发。
- **PowerShell 7**：仅 `engine: ps` 或 auto 回落时需要，不随包分发。
- **游戏录像与成片**：`out/` 不在仓库内（见 `.gitignore`）。
