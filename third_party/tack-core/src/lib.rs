//! tack-core 的最小替身。
//!
//! `tack-ocr` 只用到 `tack_core::punct`（中文/ASCII 标点与句末判定），所以这里只保留这一个模块，
//! 不把上游整个 23.7k 行（markdown 渲染、选句、翻译等）搬进本仓库。
//!
//! 快照来源、同步方式和许可证见 `third_party/README.md`。
#![forbid(unsafe_code)]

pub mod punct;
