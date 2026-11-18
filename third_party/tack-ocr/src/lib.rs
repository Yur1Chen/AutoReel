//! PP-OCRv6_small 推理：BGRA 顶朝下 → 文本行。无 Win32。

mod det;
mod order;
mod preprocess;
mod rec;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use rten::{Model, RunOptions, ThreadPool};
use rten_tensor::prelude::*;
use rten_tensor::NdTensor;

/// 识别失败原因（语义枚举；用户文案由 UI 层映射，Display 仅用于日志）。
#[derive(Debug)]
pub enum OcrError {
    ResourceMissing,
    LoadDet(String),
    LoadRec(String),
    DictRead(String),
    EmptySize,
    PixelLenMismatch,
    CropEmpty,
    BadImageSize,
    PixelSizeMismatch,
    DetRun(String),
    DetShape(String),
    RecRun(String),
    RecShape(String),
    Panic,
}

impl std::fmt::Display for OcrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ResourceMissing => f.write_str("ocr resources missing"),
            Self::LoadDet(d) => write!(f, "load det failed: {d}"),
            Self::LoadRec(d) => write!(f, "load rec failed: {d}"),
            Self::DictRead(d) => write!(f, "read dict failed: {d}"),
            Self::EmptySize => f.write_str("empty image size"),
            Self::PixelLenMismatch => f.write_str("pixel buffer length mismatch"),
            Self::CropEmpty => f.write_str("empty recognition crop"),
            Self::BadImageSize => f.write_str("invalid image size"),
            Self::PixelSizeMismatch => f.write_str("pixel data does not match size"),
            Self::DetRun(d) => write!(f, "det run failed: {d}"),
            Self::DetShape(d) => write!(f, "det shape mismatch: {d}"),
            Self::RecRun(d) => write!(f, "rec run failed: {d}"),
            Self::RecShape(d) => write!(f, "rec shape mismatch: {d}"),
            Self::Panic => f.write_str("recognition panicked"),
        }
    }
}

impl std::error::Error for OcrError {}

/// 段内一框对应的 UTF-16 字符区间（相对 `OcrLine.text`；与结果卡坐标系一致）。
#[derive(Clone, Debug)]
pub struct BoxSpan {
    pub utf16_start: usize,
    pub utf16_end: usize,
    pub quad: [[f32; 2]; 4],
    /// 所属视觉行在段内的序号（`cluster_paragraphs` 合并时累加；高亮连通分组用）。
    pub row: usize,
    /// 每个 UTF-16 单元沿阅读轴的中心位置比例（0..1；字级裁剪用）。
    /// 长度 = `utf16_end - utf16_start`；空 = 无字位数据（回退整框）。
    pub char_x: Vec<f32>,
}

/// 高亮矩形（原图坐标）+ 裁剪边标记：裁剪边不参与屏幕外扩（避免吃到邻字）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HlRect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub clip_l: bool,
    pub clip_r: bool,
}

#[derive(Clone)]
pub struct OcrLine {
    /// 同一视觉段落（可能含多个紧排 det 行）拼好后的整段。
    pub text: String,
    /// 成员识别分均值。
    pub score: f32,
    /// 该段合并的视觉行数（版式数据集 `eval_layout` 评分用）。
    pub rows: usize,
    /// 该段各检测框的四边形（原图坐标；图文对照 / 翻译复用）。
    pub quads: Vec<[[f32; 2]; 4]>,
    /// 与 `quads` 同源；记录每个框在段文本中的 UTF-16 区间（含 join 插入的空格归属到后段）。
    pub box_spans: Vec<BoxSpan>,
}

#[derive(Clone)]
pub struct OcrOutput {
    pub lines: Vec<OcrLine>,
}

impl OcrOutput {
    pub fn text_crlf(&self) -> String {
        // 段间空行：拉开卡上段距（无 DWrite paragraph spacing API 时的折中）。
        self.lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\r\n\r\n")
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// 与结果卡 `to_utf16(text_crlf())` 一致：`\r\n`→`\n` 后的 UTF-16。
    pub fn card_utf16(&self) -> Vec<u16> {
        self.text_crlf()
            .replace("\r\n", "\n")
            .replace("\r", "\n")
            .encode_utf16()
            .collect()
    }

    /// 卡 UTF-16 选区/句区间 → 相交 det quads（原图坐标）。空区间返回空。
    pub fn quads_for_utf16_range(&self, start: usize, end: usize) -> Vec<[[f32; 2]; 4]> {
        if end <= start {
            return Vec::new();
        }
        let mut cursor = 0usize;
        let mut out = Vec::new();
        let n = self.lines.len();
        for (i, line) in self.lines.iter().enumerate() {
            let line_len = utf16_len(&line.text);
            let lo = cursor;
            let hi = cursor + line_len;
            let a = start.max(lo);
            let b = end.min(hi);
            if a < b {
                let local_a = a - lo;
                let local_b = b - lo;
                for sp in &line.box_spans {
                    if sp.utf16_end > local_a && sp.utf16_start < local_b {
                        out.push(sp.quad);
                    }
                }
            }
            cursor = hi;
            if i + 1 < n {
                cursor += 2; // 卡上段间 \n\n
            }
        }
        out
    }

    /// 卡 UTF-16 选区/句区间 → 连通高亮矩形（原图坐标；`[x0,y0,x1,y1]`）。
    /// 结构驱动、无阈值：同一视觉行内的框并成一段；同段相邻行水平重叠则桥接；
    /// 跨段/跨栏不连。行/段身份来自聚段结果，与卡面排版同源。
    pub fn highlight_rects_for_utf16_range(&self, start: usize, end: usize) -> Vec<HlRect> {
        if end <= start {
            return Vec::new();
        }
        let mut runs: Vec<HlRun> = Vec::new();
        let mut cursor = 0usize;
        let n = self.lines.len();
        for (i, line) in self.lines.iter().enumerate() {
            let line_len = utf16_len(&line.text);
            let lo = cursor;
            let hi = cursor + line_len;
            let a = start.max(lo);
            let b = end.min(hi);
            if a < b {
                let local_a = a - lo;
                let local_b = b - lo;
                for sp in &line.box_spans {
                    if sp.utf16_end > local_a && sp.utf16_start < local_b {
                        let (quad, clip_l, clip_r) = clip_quad(sp, local_a, local_b);
                        let r = quad_aabb(&quad);
                        match runs.last_mut() {
                            Some(last) if last.line == i && last.row == sp.row => {
                                if r[0] < last.rect[0] {
                                    last.clip_l = clip_l;
                                }
                                if r[2] > last.rect[2] {
                                    last.clip_r = clip_r;
                                }
                                last.rect = union_rect(last.rect, r);
                            }
                            _ => runs.push(HlRun {
                                line: i,
                                row: sp.row,
                                rect: r,
                                clip_l,
                                clip_r,
                            }),
                        }
                    }
                }
            }
            cursor = hi;
            if i + 1 < n {
                cursor += 2; // 卡上段间 \n\n
            }
        }
        let mut out = Vec::with_capacity(runs.len() * 2);
        for (k, run) in runs.iter().enumerate() {
            out.push(HlRect {
                x0: run.rect[0],
                y0: run.rect[1],
                x1: run.rect[2],
                y1: run.rect[3],
                clip_l: run.clip_l,
                clip_r: run.clip_r,
            });
            let Some(next) = runs.get(k + 1) else {
                continue;
            };
            if next.line != run.line || next.row != run.row + 1 {
                continue;
            }
            let ix0 = run.rect[0].max(next.rect[0]);
            let ix1 = run.rect[2].min(next.rect[2]);
            if ix1 > ix0 && run.rect[3] < next.rect[1] {
                // 桥接边继承决定该边的那侧行段标记。
                let clip_l = if run.rect[0] >= next.rect[0] {
                    run.clip_l
                } else {
                    next.clip_l
                };
                let clip_r = if run.rect[2] <= next.rect[2] {
                    run.clip_r
                } else {
                    next.clip_r
                };
                out.push(HlRect {
                    x0: ix0,
                    y0: run.rect[3],
                    x1: ix1,
                    y1: next.rect[1],
                    clip_l,
                    clip_r,
                });
            }
        }
        out
    }
}

/// 行段中间结果：并段后的矩形 + 左/右边是否由字级裁剪决定。
struct HlRun {
    line: usize,
    row: usize,
    rect: [f32; 4],
    clip_l: bool,
    clip_r: bool,
}

/// 四边形 AABB（原图坐标）。
fn quad_aabb(quad: &[[f32; 2]; 4]) -> [f32; 4] {
    let mut r = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for p in quad {
        r[0] = r[0].min(p[0]);
        r[1] = r[1].min(p[1]);
        r[2] = r[2].max(p[0]);
        r[3] = r[3].max(p[1]);
    }
    r
}

/// 裁剪后的最小宽度比例（约半字宽），避免极窄选区出现退化框。
const HL_MIN_CLIP_FRAC: f32 = 0.02;

/// 选区与框相交时，按字位（`char_x`）把 quad 沿阅读轴裁剪到相交区间，并给出
/// 左/右边缘是否由裁剪决定（裁剪边不参与屏幕外扩）。无字位数据时回退整框。
/// quad 角序 = [TL, TR, BR, BL]，阅读轴 = 上边 0→1、下边 3→2，按比例线性插值。
fn clip_quad(sp: &BoxSpan, local_a: usize, local_b: usize) -> ([[f32; 2]; 4], bool, bool) {
    let n = sp.utf16_end.saturating_sub(sp.utf16_start);
    if n == 0 || sp.char_x.len() != n {
        return (sp.quad, false, false);
    }
    let s = local_a.max(sp.utf16_start) - sp.utf16_start;
    let e = local_b.min(sp.utf16_end) - sp.utf16_start;
    let clip_l = s > 0;
    let clip_r = e < n;
    if !clip_l && !clip_r {
        return (sp.quad, false, false);
    }
    let mut t0 = if clip_l { boundary_frac(&sp.char_x, s) } else { 0.0 };
    let mut t1 = if clip_r { boundary_frac(&sp.char_x, e) } else { 1.0 };
    t0 = t0.clamp(0.0, 1.0);
    t1 = t1.clamp(0.0, 1.0);
    if t1 - t0 < HL_MIN_CLIP_FRAC {
        let mid = (t0 + t1) * 0.5;
        t0 = (mid - HL_MIN_CLIP_FRAC * 0.5).clamp(0.0, 1.0);
        t1 = (mid + HL_MIN_CLIP_FRAC * 0.5).clamp(0.0, 1.0);
    }
    if t1 <= t0 {
        return (sp.quad, false, false);
    }
    let q = &sp.quad;
    let lerp = |a: [f32; 2], b: [f32; 2], t: f32| {
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    };
    (
        [
            lerp(q[0], q[1], t0),
            lerp(q[0], q[1], t1),
            lerp(q[3], q[2], t1),
            lerp(q[3], q[2], t0),
        ],
        clip_l,
        clip_r,
    )
}

/// UTF-16 单元 `i` 的左边界 = 与前一单元中心的中点。
fn boundary_frac(char_x: &[f32], i: usize) -> f32 {
    if i == 0 {
        0.0
    } else {
        (char_x[i - 1] + char_x[i]) * 0.5
    }
}

fn union_rect(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

pub fn is_large_selection(w: i32, h: i32) -> bool {
    w.max(h) > 1920 || (w as i64) * (h as i64) > 2_000_000
}

pub struct Engine {
    det: Model,
    rec: Model,
    alphabet: Vec<String>,
    run_opts: RunOptions,
}

impl Engine {
    pub fn load(dir: &Path) -> Result<Self, OcrError> {
        let det_path = dir.join("det.rten");
        let rec_path = dir.join("rec.rten");
        let dict_path = dir.join("ppocrv6_dict.txt");
        if !det_path.is_file() || !rec_path.is_file() || !dict_path.is_file() {
            return Err(OcrError::ResourceMissing);
        }
        let det = unsafe { Model::load_mmap(&det_path) }
            .map_err(|e| OcrError::LoadDet(e.to_string()))?;
        let rec = unsafe { Model::load_mmap(&rec_path) }
            .map_err(|e| OcrError::LoadRec(e.to_string()))?;
        let dict_text =
            fs::read_to_string(&dict_path).map_err(|e| OcrError::DictRead(e.to_string()))?;
        let mut dict: Vec<String> = dict_text.lines().map(|s| s.to_string()).collect();
        if dict.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
            dict.pop();
        }
        let mut alphabet = Vec::with_capacity(dict.len() + 2);
        alphabet.push(String::new());
        alphabet.extend(dict);
        alphabet.push(" ".to_string());
        let pool = Arc::new(ThreadPool::with_num_threads(2));
        let run_opts = RunOptions {
            thread_pool: Some(pool),
            ..Default::default()
        };
        Ok(Self {
            det,
            rec,
            alphabet,
            run_opts,
        })
    }

    pub fn recognize_bgra(&self, bgra: &[u8], w: u32, h: u32) -> Result<OcrOutput, OcrError> {
        if w == 0 || h == 0 {
            return Err(OcrError::EmptySize);
        }
        let expected = (w as usize)
            .checked_mul(h as usize)
            .and_then(|p| p.checked_mul(4));
        if expected != Some(bgra.len()) {
            return Err(OcrError::PixelLenMismatch);
        }
        let bench = bench_enabled();
        let e2e = Instant::now();
        let (orig_w, orig_h) = (w, h);
        // 小图 N× 上采样：细笔画/小字在 rec 归一化前先放大（§7.2 实验）。
        // 超限不动（4K 大图内存/耗时保护）；`TACK_OCR_UPSCALE=0` 关闭。
        let factor = upscale_factor();
        let up = factor >= 2 && w.max(h) <= UPSCALE_MAX_SIDE && (w as u64) * (h as u64) <= UPSCALE_MAX_PIXELS;
        let up_start = Instant::now();
        let up_buf = if up {
            preprocess::upscale_bgra(bgra, w, h, factor)
        } else {
            Vec::new()
        };
        let up_ms = if up {
            up_start.elapsed().as_secs_f64() * 1e3
        } else {
            0.0
        };
        let (bgra, w, h) = if up {
            (up_buf.as_slice(), w * factor, h * factor)
        } else {
            (bgra, w, h)
        };
        let det_start = Instant::now();
        let (input, scale_x, scale_y) = preprocess::det_tensor(bgra, w, h)?;
        let shape = input.shape();
        let (det_h, det_w) = (shape[2] as u32, shape[3] as u32);
        let out = self
            .det
            .run_one(input.into(), Some(self.run_opts.clone()))
            .map_err(|e| OcrError::DetRun(e.to_string()))?;
        let prob: NdTensor<f32, 4> = out
            .try_into()
            .map_err(|e| OcrError::DetShape(format!("{e}")))?;
        let boxes = det::db_boxes(&prob, scale_x, scale_y, w, h);
        let det_ms = det_start.elapsed().as_secs_f64() * 1e3;
        let groups = order::sort_reading(&boxes);
        let rec_start = Instant::now();
        let mut out = assemble_lines(&groups, &boxes, |bx| {
            let input = preprocess::rec_tensor(bgra, w, h, &bx.quad)?;
            let out = self
                .rec
                .run_one(input.into(), Some(self.run_opts.clone()))
                .map_err(|e| OcrError::RecRun(e.to_string()))?;
            let logits: NdTensor<f32, 3> = out
                .try_into()
                .map_err(|e| OcrError::RecShape(format!("{e}")))?;
            Ok(rec::ctc_decode(&logits, &self.alphabet))
        })?;
        if up {
            scale_geometry_to_original(&mut out, factor);
        }
        if bench {
            eprintln!(
                "ocr_bench img={orig_w}x{orig_h} up={} up_ms={up_ms:.1} det_in={det_w}x{det_h} boxes={} det_ms={:.1} rec_ms={:.1} e2e_ms={:.1}",
                if up { factor } else { 0 },
                boxes.len(),
                det_ms,
                rec_start.elapsed().as_secs_f64() * 1e3,
                e2e.elapsed().as_secs_f64() * 1e3,
            );
        }
        Ok(out)
    }
}

/// 上采样识别后把几何换回原图像素；`quads` 与 `box_spans` 同源，必须同步换算。
fn scale_geometry_to_original(out: &mut OcrOutput, factor: u32) {
    let f = factor as f32;
    for line in &mut out.lines {
        for q in &mut line.quads {
            for p in q {
                p[0] /= f;
                p[1] /= f;
            }
        }
        for sp in &mut line.box_spans {
            for p in &mut sp.quad {
                p[0] /= f;
                p[1] /= f;
            }
        }
    }
}

/// `TACK_OCR_BENCH=1` 时每次识别向 stderr 打一行分段耗时（含 `up_ms`；默认关，见
/// `docs/OCR-DET1920-UNCLIP-2026-09-21.md` §5）。
fn bench_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| matches!(std::env::var("TACK_OCR_BENCH").as_deref(), Ok("1")))
}

/// `TACK_OCR_ROWS=1` 时按栏向 stderr 打视觉行几何（y0/y1/行高/gap/框数/
/// table-ish/行文本 + 中位行高与断合阈值），聚段阈值调参用（默认关）。
fn rows_debug_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| matches!(std::env::var("TACK_OCR_ROWS").as_deref(), Ok("1")))
}

/// 小图 N× 上采样上限（最长边 / 像素）：只覆盖截图级小图，4K 大图不动。
const UPSCALE_MAX_SIDE: u32 = 2000;
const UPSCALE_MAX_PIXELS: u64 = 4_000_000;

/// 上采样倍率：`TACK_OCR_UPSCALE` = 0 关闭 / 2 / 3（默认）/ 4；非法按默认。
fn upscale_factor() -> u32 {
    static ON: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *ON.get_or_init(|| match std::env::var("TACK_OCR_UPSCALE").as_deref() {
        Ok("0") => 0,
        Ok(v) => v
            .parse::<u32>()
            .ok()
            .filter(|f| (2..=4).contains(f))
            .unwrap_or(3),
        Err(_) => 3,
    })
}

/// 行内成员：识别输出（文本/分/字位）+ 框几何；`join_parts_with_spans` 输入。
struct RowMember {
    text: String,
    score: f32,
    quad: [[f32; 2]; 4],
    centers: Vec<f32>,
}

/// 视觉行中间结果（聚段前）。
struct VisualRow {
    text: String,
    score: f32,
    quads: Vec<[[f32; 2]; 4]>,
    box_spans: Vec<BoxSpan>,
    y0: i32,
    y1: i32,
    /// 本行 AABB 宽（合段后保留最后一行的宽，供「短行不成续行」判定）。
    w: f32,
    /// 本行由几条视觉行合并而来（单行时 1）。
    rows: usize,
    /// 行内各框 AABB 的 x 中心，供表感列对齐粗检。
    centers_x: Vec<f32>,
}

/// 段间空隙分带（相对中位行高）：
/// - `gap ≥ HI`：空行 / 段距 / 列表项距，必断段（不看标点）。
/// - 其余边界：v3 标点仲裁——上一行满宽且未收句 + 下一行收句 → 合；
///   上一行收句且该隙偏离本栏折行距（或下一行不满宽）→ 断；
///   v3.3 补：两侧都未收句 + 下行满宽 + 行内有句内标点（，、）→ 句中折行 → 合（`mid`）；
///   v3.4 补：末对（段尾）+ 两侧未收句 + 末行明显窄 + 本段有句内标点 → 折行尾行 → 合（`tail`）；
///   v3.5 补：`tail` 证据追加英文悬空虚词（行尾 `the` `be` `of` 等不能收句的词，英文折行高频信号）；
///   再落几何兜底（short / taper / narrow）。
///   见 `docs/OCR-CARD-PARAGRAPH-V3-2026-09-25.md`。
///
/// 实测样本（TapTap 长文，行距 1.4–1.5）：段内 gap ≈ 0.84–1.0×h，段间 ≈ 2.8×h；
/// 居中列表/海报（每项短行、均匀小空隙）靠满宽规则逐行断段。
const PARA_GAP_LO_RATIO: f32 = 1.0;
const PARA_GAP_HI_RATIO: f32 = 1.55;
const PARA_GAP_MIN_PX: f32 = 6.0;
/// v2 小增量（全量 v2 分型被基准否决，只保留这条；见 `docs/OCR-CARD-PARAGRAPH-V2-2026-09-24.md`）：
/// 小隙簇离群 `gap_hi_c = gap_med + 1.8 × max(gap_mad, 0.15×median_h)`，用于识别
/// 「短行对被离群大隙 + 满宽起行闭合」的折行段落（否则会被短行规则逐行撕开）。
/// v3 起也用于「上一行句末 + 该隙离群 → 段界」（见 V3 文档 §3）。
const GAP_OUTLIER_K: f32 = 1.8;
const GAP_MAD_FLOOR_RATIO: f32 = 0.15;
/// 无空隙对比（整栏均匀间距）时，末行明显窄于上一行 → 独立副标题/海报行。
const NARROW_TAIL_RATIO: f32 = 0.6;
/// 满宽阈值：上一行宽 < 该比例 × 栏内最宽行 → 短行，不作为 wrap 续行。
const FULL_LINE_RATIO: f32 = 0.9;
/// 表感：连续至少这么多「多框行」且列中心稳定 → 禁止纵向合段。
const TABLEISH_ROWS_MIN: usize = 3;

/// 按分组逐行识别后：栏内按纵向空隙聚成视觉段落；段间由 `text_crlf()` 双换行。
fn assemble_lines(
    groups: &[order::ReadingColumn],
    boxes: &[det::DetBox],
    mut recognize: impl FnMut(&det::DetBox) -> Result<rec::RecOut, OcrError>,
) -> Result<OcrOutput, OcrError> {
    let mut lines = Vec::new();
    for column in groups {
        let mut rows: Vec<VisualRow> = Vec::new();
        for row in &column.rows {
            let mut members: Vec<RowMember> = Vec::new();
            for &i in &row.idxs {
                let bx = &boxes[i];
                let out = recognize(bx)?;
                if out.score < rec::SCORE_THRESH || out.text.is_empty() {
                    continue;
                }
                members.push(RowMember {
                    text: out.text,
                    score: out.score,
                    quad: bx.quad,
                    centers: out.centers,
                });
            }
            if members.is_empty() {
                continue;
            }
            let score =
                members.iter().map(|m| m.score).sum::<f32>() / members.len() as f32;
            let parts: Vec<PartRef> = members
                .iter()
                .map(|m| (m.text.as_str(), m.quad, m.centers.as_slice()))
                .collect();
            let (text, box_spans) = join_parts_with_spans(&parts);
            let quads: Vec<_> = box_spans.iter().map(|s| s.quad).collect();
            let (y0, y1, w, centers_x) = row_geometry(&quads);
            rows.push(VisualRow {
                text,
                score,
                quads,
                box_spans,
                y0,
                y1,
                w,
                rows: 1,
                centers_x,
            });
        }
        lines.extend(cluster_paragraphs(rows));
    }
    Ok(OcrOutput { lines })
}

fn row_geometry(quads: &[[[f32; 2]; 4]]) -> (i32, i32, f32, Vec<f32>) {
    let mut y0 = i32::MAX;
    let mut y1 = i32::MIN;
    let mut x_min = f32::MAX;
    let mut x_max = f32::MIN;
    let mut centers_x = Vec::with_capacity(quads.len());
    for q in quads {
        let mut x0 = f32::MAX;
        let mut x1 = f32::MIN;
        for p in q {
            let x = p[0];
            let y = p[1].round() as i32;
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
        }
        x_min = x_min.min(x0);
        x_max = x_max.max(x1);
        centers_x.push((x0 + x1) / 2.0);
    }
    if y0 > y1 {
        (0, 0, 0.0, centers_x)
    } else {
        (y0, y1, (x_max - x_min).max(0.0), centers_x)
    }
}

fn median_f32(mut v: Vec<f32>) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// 小隙簇估计：最小半数为种子，1.8× 种子中位截断；簇内算 med/MAD。
/// 段间大空（双峰的另一峰）不参与，避免抬高 med / 撑爆 MAD。
fn small_gap_stats(gaps: &[f32]) -> (f32, f32) {
    let mut v: Vec<f32> = gaps.iter().copied().filter(|g| *g > 0.0).collect();
    if v.is_empty() {
        return (0.0, 0.0);
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let seed_n = v.len().div_ceil(2).max(1);
    let seed_med = median_f32(v[..seed_n].to_vec());
    let cut = (seed_med * 1.8).max(1.0);
    let intra: Vec<f32> = v.into_iter().filter(|g| *g <= cut).collect();
    let med = median_f32(intra.clone());
    let mad = median_f32(intra.iter().map(|g| (g - med).abs()).collect());
    (med, mad)
}

/// 行尾是否为句末：共享 `tack_core::punct`（与选句同源；见 V3 文档 §2/§8）。
fn line_ends_sentence(text: &str) -> bool {
    let seq: Vec<u16> = text.encode_utf16().collect();
    tack_core::punct::ends_sentence(&seq)
}

/// 行尾是否以逗号/顿号收尾（句内停顿 → 句子必续；v3.1）。
fn line_ends_intra_punct(text: &str) -> bool {
    let seq: Vec<u16> = text.encode_utf16().collect();
    tack_core::punct::ends_with_intra_punct(&seq)
}

/// 行内是否含句内标点（逗号/顿号）——v3.3 句中折行续接的标点痕迹。
fn contains_intra_punct(text: &str) -> bool {
    let seq: Vec<u16> = text.encode_utf16().collect();
    tack_core::punct::contains_intra_punct(&seq)
}

/// v3.5 英文悬空虚词：行尾 ASCII 单词为「不能收句」的功能词（冠词/限定词/介词/
/// 并列连词/be 动词/情态），出现即句子必续——英文排版折行的高频信号。
/// 宁缺毋滥：`can` `did` `over` `not` 等可独立收句（"Yes I can."）的词不收。
const DANGLING_WORDS: &[&str] = &[
    // 冠词 / 限定词
    "a", "an", "the", "my", "your", "our", "their", "its",
    // 介词
    "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "onto", "about", "after",
    "before", "between", "through", "during", "without", "against", "among", "upon", "within",
    "toward", "towards", "than", "as",
    // 并列连词
    "and", "or", "nor", "but",
    // be 动词 / 情态
    "be", "is", "are", "was", "were", "am", "been", "will", "would", "shall", "should",
];

/// 行尾（trim 后）是否为纯 ASCII 字母的悬空虚词；大小写不敏感。
fn ends_with_dangling_word(text: &str) -> bool {
    let t = text.trim_end();
    let start = t
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_ascii_alphabetic())
        .last()
        .map(|(i, _)| i);
    start.is_some_and(|i| DANGLING_WORDS.contains(&t[i..].to_ascii_lowercase().as_str()))
}

/// 行尾（跳空白/收尾符）是否以停顿标点收尾（`，,、；;：:`）——v3.3 `mid` 不适用。
fn ends_with_pause_punct(text: &str) -> bool {
    let seq: Vec<u16> = text.encode_utf16().collect();
    tack_core::punct::ends_with_pause_punct(&seq)
}

/// 断点是否落在未闭合配对内（配对优先判定用；v3.2）。
/// 要求 next 真正闭合 prev 的开符号，而非只含 next 自身成对的同族闭符号。
fn pair_crosses_break(prev: &str, next: &str) -> bool {
    let a: Vec<u16> = prev.encode_utf16().collect();
    let b: Vec<u16> = next.encode_utf16().collect();
    tack_core::punct::pair_crosses_break(&a, &b)
}

/// emoji / 变体选择符 / ZWJ（识别模型无 emoji 字表，但可能吐出行首符号）。
fn is_emoji(c: char) -> bool {
    matches!(
        c as u32,
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0xFE00..=0xFE0F | 0x200D | 0x20E3
    )
}

/// 常见项目符号（非 emoji 区间的几何符号；含 rec 可能把 `•` 映射成的中点变体）。
fn is_bullet(c: char) -> bool {
    matches!(
        c,
        '•' | '‣' | '▪' | '▫' | '◆' | '◇' | '●' | '○' | '◦' | '※' | '·' | '・' | '∙' | '⋅'
    )
}

/// 行首是否为列表标记：emoji / 项目符号 / ASCII 编号（`1.` `1、` `1)` `1）`）。
/// 仅作「列表项边界」信号，不改变文本内容。
fn starts_with_marker(text: &str) -> bool {
    let t = text.trim_start();
    let mut it = t.chars().peekable();
    let Some(first) = it.next() else {
        return false;
    };
    if is_emoji(first) || is_bullet(first) {
        return true;
    }
    if first.is_ascii_digit() {
        let mut digits = 1;
        while matches!(it.peek(), Some(c) if c.is_ascii_digit()) && digits < 2 {
            it.next();
            digits += 1;
        }
        return match it.next() {
            Some('.') => !matches!(it.peek(), Some(c) if c.is_ascii_digit()), // 排除 1.5
            Some('、') | Some(')') | Some('）') => true,
            _ => false,
        };
    }
    false
}

/// 等宽短 CJK 无标点栏硬断（v3.6 / 提案 A）：专治五/七言等宽诗行（版式 case 14）。
/// 整栏一次性判定；命中则每视觉行独立成段，覆盖 pairwise `default` 合并。
/// 不等宽（case 15）与无标点散文 wrap 不触发；不收紧 short / DenseShort。
const EQ_CJK_WIDTH_RATIO: f32 = 1.05;
const EQ_CJK_CHARS_MIN: usize = 3;
const EQ_CJK_CHARS_MAX: usize = 7;

/// 去空白后的 CJK 字符数（与 `tack_core::punct::is_cjk` 同源）。
fn cjk_char_count_stripped(text: &str) -> usize {
    text.chars()
        .filter(|c| !c.is_whitespace() && tack_core::punct::is_cjk(*c))
        .count()
}

/// 整栏是否命中「等宽短 CJK 无标点」硬断。
fn is_equal_width_cjk_column(
    rows: &[VisualRow],
    gaps: &[f32],
    hi: f32,
    has_gap_contrast: bool,
    tableish: &[bool],
) -> bool {
    if rows.len() < 3 {
        return false;
    }
    let min_w = rows.iter().map(|r| r.w).fold(f32::MAX, f32::min);
    let max_w = rows.iter().map(|r| r.w).fold(0.0_f32, f32::max);
    if !(min_w > 0.0 && max_w / min_w <= EQ_CJK_WIDTH_RATIO) {
        return false;
    }
    if tableish.iter().any(|&t| t) || rows.iter().any(|r| starts_with_marker(&r.text)) {
        return false;
    }
    for r in rows {
        let n_cjk = cjk_char_count_stripped(&r.text);
        if !(EQ_CJK_CHARS_MIN..=EQ_CJK_CHARS_MAX).contains(&n_cjk) {
            return false;
        }
        // 去空白后须全是 CJK（窄栏：排除混排拉丁）。
        let non_ws: String = r.text.chars().filter(|c| !c.is_whitespace()).collect();
        if non_ws.chars().count() != n_cjk {
            return false;
        }
        if line_ends_sentence(&r.text) || contains_intra_punct(&r.text) {
            return false;
        }
    }
    // 空隙条件：无离群大隙（gap_hi_c 口径，`has_gap_contrast=false`），或全栏无硬断隙
    // （全部 gap < hi）。仅当两者皆不满足（既有离群隙、又存在 ≥hi 硬断隙）才跳过，
    // 交回 pairwise 几何（不覆盖显式断隙结构）；均匀大隙（离群口径无对比）仍整栏硬断。
    let all_gaps_below_hi = gaps.iter().all(|g| *g < hi);
    !has_gap_contrast || all_gaps_below_hi
}

/// 栏内视觉行 → 段落 `OcrLine`（一段一个）。
fn cluster_paragraphs(rows: Vec<VisualRow>) -> Vec<OcrLine> {
    if rows.is_empty() {
        return Vec::new();
    }
    let heights: Vec<f32> = rows
        .iter()
        .map(|r| (r.y1 - r.y0).max(1) as f32)
        .collect();
    let median_h = median_f32(heights).max(1.0);
    let lo = PARA_GAP_MIN_PX.max(PARA_GAP_LO_RATIO * median_h);
    let hi = PARA_GAP_MIN_PX.max(PARA_GAP_HI_RATIO * median_h);
    let full_w = FULL_LINE_RATIO * rows.iter().map(|r| r.w).fold(0.0, f32::max).max(1.0);
    let row_ws: Vec<f32> = rows.iter().map(|r| r.w).collect();
    let median_w = median_f32(row_ws.clone()).max(1.0);
    let gaps: Vec<f32> = rows
        .windows(2)
        .map(|p| (p[1].y0 - p[0].y1).max(0) as f32)
        .collect();
    let (gap_med, gap_mad) = small_gap_stats(&gaps);
    // v3：3 行（2 隙）起即用小隙簇离群；仅 2 行（1 隙）回退固定倍率。
    let gap_hi_c = if gaps.len() < 2 {
        hi
    } else {
        PARA_GAP_MIN_PX.max(gap_med + GAP_OUTLIER_K * gap_mad.max(GAP_MAD_FLOOR_RATIO * median_h))
    };
    let has_gap_contrast = gaps.iter().any(|g| *g >= gap_hi_c);
    let tableish = tableish_mask(&rows);

    if rows_debug_enabled() {
        for (i, r) in rows.iter().enumerate() {
            let gap = if i == 0 {
                0
            } else {
                (r.y0 - rows[i - 1].y1).max(0)
            };
            eprintln!(
                "row{i}: y0={} y1={} h={} gap={} w={:.0} full={} boxes={} tableish={} text={:?}",
                r.y0,
                r.y1,
                r.y1 - r.y0,
                gap,
                r.w,
                r.w >= full_w,
                r.centers_x.len(),
                tableish[i],
                r.text
            );
        }
        eprintln!(
            "median_h={median_h:.1} median_w={median_w:.1} lo={lo:.1} hi={hi:.1} full_w={full_w:.1} \
             gap_med={gap_med:.1} gap_mad={gap_mad:.1} gap_hi_c={gap_hi_c:.1} contrast={has_gap_contrast}"
        );
    }

    // v3.6：等宽短 CJK 无标点栏 → 整栏硬断（每行独立段；decision=eq_cjk）。
    // 在 pairwise 之前覆盖 `default` 合并；不收紧 short，不影响 case 15 / 散文 wrap。
    if is_equal_width_cjk_column(&rows, &gaps, hi, has_gap_contrast, &tableish) {
        if rows_debug_enabled() {
            eprintln!("column decision=eq_cjk (equal-width short CJK, hard-split all)");
        }
        return rows.into_iter().map(visual_to_line).collect();
    }

    let mut out = Vec::new();
    let mut cur: Option<VisualRow> = None;
    for (i, row) in rows.into_iter().enumerate() {
        if let Some(prev) = cur.take() {
            let gap = (row.y0 - prev.y1).max(0) as f32;
            let short_prev = prev.w < full_w;
            let short_next = row.w < full_w;
            let prev_full = prev.w >= full_w;
            let prev_done = line_ends_sentence(&prev.text);
            let next_done = line_ends_sentence(&row.text);
            // 行首项目符号/编号：新列表项边界（无条件断）。
            let marker_next = starts_with_marker(&row.text);
            // 满宽后续行也短（再下一行仍短）→ 该满宽行更像独立项（海报/列表行），非段首。
            // 护栏：第一个短行以句末标点结尾（散文段尾）或上一行本身是列表项（折行应合回）时不触发。
            let taper = !short_prev
                && short_next
                && row_ws.get(i + 1).is_some_and(|w| *w < full_w)
                && !next_done
                && !starts_with_marker(&prev.text);
            // v2 追加：短行对若被「离群大隙 + 满宽起行」闭合（且自身隙不离群、prev 非极短行），
            // 则是折行段落的尾行、不是独立项 → 合（防短行规则把折行段落撕开）。
            // 注：`i` 是 next 行的 0 基下标；gap 后一隙 = gaps[i]，再下一行 = row_ws[i + 1]。
            // 必须是短行对（文档 §14.2）：否则满宽句末 + 灰区会被「后一离群隙」误合。
            let closure = i + 1 < row_ws.len()
                && short_prev
                && short_next
                && gap <= gap_hi_c
                && gaps[i] >= gap_hi_c
                && row_ws[i + 1] >= FULL_LINE_RATIO * median_w
                && prev.w >= 0.5 * median_w;
            // v2 追加：整栏无空隙对比（均匀间距）时，末行明显窄于上一行 → 独立副标题/海报行。
            let narrow_tail = !has_gap_contrast
                && i + 1 == row_ws.len()
                && row.w < NARROW_TAIL_RATIO * prev.w
                && !starts_with_marker(&prev.text);
            // v3.2 配对优先：断点落在未闭合配对内（上行开、下行闭，半/全角同族）→ 合；
            // 配对是「必须闭合」的结构信号，优先于 short/taper/narrow/句意分界（空行/表感/标记仍最高）。
            let pair_merge = pair_crosses_break(&prev.text, &row.text);
            // v3 标点仲裁（`docs/OCR-CARD-PARAGRAPH-V3-2026-09-25.md` §3）：
            // 句意续接——① 断点在句内（上行满宽未收句、下行收句）→ 合；满宽护栏防海报字段被粘；
            // ② 上行以逗号/顿号收尾 → 句子必续（v3.1；防 bullet 折行尾被 narrow_tail 撕开）。
            let continuation =
                (prev_full && !prev_done && next_done) || line_ends_intra_punct(&prev.text);
            // v3.4 段尾折行（仅末对）：narrow_tail 的形状（末行明显窄）平时判「独立副标题」，
            // 但本段已有句内标点痕迹 / 上行以英文悬空虚词收尾，且两侧未收句 → 是折行段落的
            // 尾行（含英文句尾换行）→ 合；证据随段落累积、断段后重置，不影响中间行几何判定。
            let prose_tail = i + 1 == row_ws.len()
                && !prev_done
                && row.w < NARROW_TAIL_RATIO * prev.w
                && !ends_with_pause_punct(&prev.text)
                && (contains_intra_punct(&prev.text)
                    || contains_intra_punct(&row.text)
                    || ends_with_dangling_word(&prev.text));
            // 句意分界——上行收句，且该隙偏离本栏折行距（或下行不满宽）→ 断。
            let sentence_break = prev_done && (gap > lo || gap >= gap_hi_c || short_next);
            // v3.3 句中折行续接（标点优先）：断点两侧都未收句（行尾是词字符）且下行是满宽折行，
            // 这一对行内又有句内标点（逗号/顿号）→ 标点判「折行未断」→ 合。
            // 无标点的诗/海报/清单、以及 `；` `：` 收尾的列表项（12 号语义）不触发，仍走几何。
            let mid_wrap = !prev_done
                && !next_done
                && row.w >= full_w
                && !ends_with_pause_punct(&prev.text)
                && (contains_intra_punct(&prev.text) || contains_intra_punct(&row.text));
            let (decide_break, reason) = if tableish[i.saturating_sub(1)]
                || tableish[i]
                || marker_next
                || gap >= hi
            {
                (true, "hard")
            } else if pair_merge {
                (false, "pair")
            } else if closure {
                (false, "closure")
            } else if continuation {
                (false, "cont")
            } else if prose_tail {
                (false, "tail")
            } else if sentence_break {
                (true, "sent")
            } else if mid_wrap {
                (false, "mid")
            } else if short_prev {
                (true, "short")
            } else if taper {
                (true, "taper")
            } else if narrow_tail {
                (true, "narrow")
            } else {
                (false, "default")
            };
            if rows_debug_enabled() {
                eprintln!(
                    "pair {i}->{} gap={gap:.1} short_prev={short_prev} short_next={short_next} \
                     marker={marker_next} taper={taper} closure={closure} narrow_tail={narrow_tail} \
                     prev_full={prev_full} prev_done={prev_done} next_done={next_done} \
                     pair={pair_merge} cont={continuation} tail={prose_tail} sent={sentence_break} \
                     mid={mid_wrap} decision={reason}",
                    i + 1
                );
            }
            if decide_break {
                out.push(visual_to_line(prev));
                cur = Some(row);
            } else {
                cur = Some(merge_visual(prev, row));
            }
        } else {
            cur = Some(row);
        }
    }
    if let Some(prev) = cur {
        out.push(visual_to_line(prev));
    }
    out
}

fn visual_to_line(r: VisualRow) -> OcrLine {
    OcrLine {
        text: r.text,
        score: r.score,
        rows: r.rows,
        quads: r.quads,
        box_spans: r.box_spans,
    }
}

fn merge_visual(mut a: VisualRow, b: VisualRow) -> VisualRow {
    let a_utf16 = utf16_len(&a.text);
    let b_utf16 = utf16_len(&b.text);
    let parts = [a.text.as_str(), b.text.as_str()];
    a.text = join_texts(&parts);
    let joined_utf16 = utf16_len(&a.text);
    let b_off = joined_utf16.saturating_sub(b_utf16);
    debug_assert!(b_off == a_utf16 || b_off == a_utf16 + 1);
    for sp in &b.box_spans {
        a.box_spans.push(BoxSpan {
            utf16_start: sp.utf16_start + b_off,
            utf16_end: sp.utf16_end + b_off,
            quad: sp.quad,
            row: sp.row + a.rows,
            char_x: sp.char_x.clone(),
        });
    }
    let n = a.quads.len() + b.quads.len();
    let score = if n == 0 {
        0.0
    } else {
        (a.score * a.quads.len() as f32 + b.score * b.quads.len() as f32) / n as f32
    };
    a.score = score;
    a.y0 = a.y0.min(b.y0);
    a.y1 = a.y1.max(b.y1);
    a.w = b.w;
    a.rows += b.rows;
    a.quads.extend(b.quads);
    a.centers_x.extend(b.centers_x);
    a
}

/// 连续 ≥3 个多框行且列中心桶稳定 → 这些行标记为 table-ish（禁止与邻居纵向合并）。
fn tableish_mask(rows: &[VisualRow]) -> Vec<bool> {
    let n = rows.len();
    let mut mask = vec![false; n];
    if n < TABLEISH_ROWS_MIN {
        return mask;
    }
    let multi: Vec<bool> = rows.iter().map(|r| r.centers_x.len() >= 2).collect();
    let mut i = 0;
    while i < n {
        if !multi[i] {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < n && multi[j] {
            j += 1;
        }
        if j - i >= TABLEISH_ROWS_MIN && columns_stable(&rows[i..j]) {
            mask[i..j].fill(true);
        }
        i = j;
    }
    mask
}

fn columns_stable(rows: &[VisualRow]) -> bool {
    // 以第一行中心为种子，后续行每个中心须落入某多种子 ± tol。
    let seeds = &rows[0].centers_x;
    if seeds.len() < 2 {
        return false;
    }
    let span = {
        let min_x = seeds.iter().cloned().fold(f32::MAX, f32::min);
        let max_x = seeds.iter().cloned().fold(f32::MIN, f32::max);
        (max_x - min_x).max(1.0)
    };
    let tol = (span * 0.12).max(12.0);
    for row in rows.iter().skip(1) {
        if row.centers_x.len() != seeds.len() {
            // 列数不一致：仍可能是表，但 stub 要求列数一致更稳。
            return false;
        }
        for &c in &row.centers_x {
            if !seeds.iter().any(|&s| (s - c).abs() <= tol) {
                return false;
            }
        }
    }
    true
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 同一视觉行内拼接：两边都是 CJK（含日韩）直连，其余补一个空格；
/// 边界已有空白则不重复补。
fn join_texts(parts: &[&str]) -> String {
    let mut out = String::new();
    for part in parts {
        if out.is_empty() {
            out.push_str(part);
            continue;
        }
        let left = out.chars().next_back();
        let right = part.chars().next();
        let spaced = left.is_some_and(char::is_whitespace) || right.is_some_and(char::is_whitespace);
        if !spaced && !(is_cjk(left) && is_cjk(right)) {
            out.push(' ');
        }
        out.push_str(part);
    }
    out
}

/// 行内一段文本 + 其框 + 字位（借用形式，供 join 使用）。
type PartRef<'a> = (&'a str, [[f32; 2]; 4], &'a [f32]);

/// 与 [`join_texts`] 同规则，同时记录每段文本在结果中的 UTF-16 区间、对应 quad 与字位。
fn join_parts_with_spans(parts: &[PartRef]) -> (String, Vec<BoxSpan>) {
    let mut out = String::new();
    let mut spans = Vec::with_capacity(parts.len());
    for &(part, quad, centers) in parts {
        if part.is_empty() {
            continue;
        }
        if !out.is_empty() {
            let left = out.chars().next_back();
            let right = part.chars().next();
            let spaced =
                left.is_some_and(char::is_whitespace) || right.is_some_and(char::is_whitespace);
            if !spaced && !(is_cjk(left) && is_cjk(right)) {
                out.push(' ');
            }
        }
        let start = utf16_len(&out);
        let char_x = expand_centers(part, centers);
        out.push_str(part);
        let end = utf16_len(&out);
        spans.push(BoxSpan {
            utf16_start: start,
            utf16_end: end,
            quad,
            row: 0,
            char_x,
        });
    }
    (out, spans)
}

/// 每 token 的中心位置展开到 UTF-16 单元（长度与 `part` 的 UTF-16 长度一致）。
/// token 与中心数不符时回退均匀分布（保证长度正确、可索引）。
fn expand_centers(part: &str, centers: &[f32]) -> Vec<f32> {
    let n = utf16_len(part);
    if n == 0 {
        return Vec::new();
    }
    let tokens: Vec<char> = part.chars().collect();
    if centers.len() != tokens.len() {
        return (0..n).map(|i| (i as f32 + 0.5) / n as f32).collect();
    }
    let mut out = Vec::with_capacity(n);
    for (i, ch) in tokens.iter().enumerate() {
        let c = centers[i].clamp(0.0, 1.0);
        out.push(c);
        if ch.len_utf16() == 2 {
            out.push(c);
        }
    }
    out
}

/// 汉字 / 假名 / 谚文以及 CJK 标点（拼接时视为同文，不加空格）。
fn is_cjk(c: Option<char>) -> bool {
    c.is_some_and(tack_core::punct::is_cjk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::det::DetBox;
    use std::path::PathBuf;

    fn hr(x0: f32, y0: f32, x1: f32, y1: f32) -> HlRect {
        HlRect {
            x0,
            y0,
            x1,
            y1,
            clip_l: false,
            clip_r: false,
        }
    }

    fn hr_c(x0: f32, y0: f32, x1: f32, y1: f32, clip_l: bool, clip_r: bool) -> HlRect {
        HlRect {
            x0,
            y0,
            x1,
            y1,
            clip_l,
            clip_r,
        }
    }

    fn bx(x0: i32, y0: i32, x1: i32, y1: i32) -> DetBox {
        DetBox {
            quad: [
                [x0 as f32, y0 as f32],
                [x1 as f32, y0 as f32],
                [x1 as f32, y1 as f32],
                [x0 as f32, y1 as f32],
            ],
            score: 0.9,
        }
    }

    fn run(boxes: &[DetBox], text_of: impl Fn(&DetBox) -> String) -> OcrOutput {
        let groups = order::sort_reading(boxes);
        assemble_lines(&groups, boxes, |b| {
            let text = text_of(b);
            let n = text.chars().count().max(1);
            let centers = (0..text.chars().count())
                .map(|i| (i as f32 + 0.5) / n as f32)
                .collect();
            Ok(rec::RecOut {
                text,
                score: 0.9,
                centers,
            })
        })
        .expect("assemble")
    }

    #[test]
    fn crlf_join() {
        let out = OcrOutput {
            lines: vec![
                OcrLine {
                    text: "你好".into(),
                    score: 1.0,
                    rows: 1,
                    quads: vec![],
                    box_spans: vec![],
                },
                OcrLine {
                    text: "world".into(),
                    score: 1.0,
                    rows: 1,
                    quads: vec![],
                    box_spans: vec![],
                },
            ],
        };
        assert_eq!(out.text_crlf(), "你好\r\n\r\nworld");
        assert_eq!(out.line_count(), 2);
    }

    #[test]
    fn same_row_boxes_merge_into_one_line() {
        let boxes: Vec<DetBox> = (1..=5)
            .map(|i| bx(i * 100, 0, i * 100 + 40, 20))
            .collect();
        let out = run(&boxes, |b| format!("{}", b.quad[0][0] as i32 / 100));
        assert_eq!(out.line_count(), 1);
        assert_eq!(out.text_crlf(), "1 2 3 4 5");
        assert_eq!(out.lines[0].quads.len(), 5);
    }

    #[test]
    fn same_row_cjk_merges_without_space() {
        let boxes = vec![bx(0, 0, 20, 20), bx(20, 0, 40, 20)];
        let out = run(&boxes, |b| {
            if b.quad[0][0] == 0.0 { "你" } else { "好" }.to_string()
        });
        assert_eq!(out.text_crlf(), "你好");
    }

    #[test]
    fn separate_rows_keep_crlf() {
        // gap=40 ≥ hi → 必断段
        let boxes = vec![bx(0, 0, 40, 20), bx(0, 60, 40, 80)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 { "上" } else { "下" }.to_string()
        });
        assert_eq!(out.text_crlf(), "上\r\n\r\n下");
    }

    #[test]
    fn two_columns_merged_still_left_column_first() {
        let mut boxes = Vec::new();
        for row in 0..3 {
            boxes.push(bx(0, row * 80, 60, row * 80 + 20));
            boxes.push(bx(300, row * 80, 380, row * 80 + 20));
        }
        let out = run(&boxes, |b| {
            if b.quad[0][0] == 0.0 {
                format!("L{}", b.quad[0][1] as i32 / 80)
            } else {
                format!("R{}", b.quad[0][1] as i32 / 80)
            }
        });
        assert_eq!(out.text_crlf(), "L0\r\n\r\nL1\r\n\r\nL2\r\n\r\nR0\r\n\r\nR1\r\n\r\nR2");
    }

    #[test]
    fn low_score_member_dropped_before_merge() {
        let boxes = vec![bx(0, 0, 40, 20), bx(100, 0, 140, 20)];
        let groups = order::sort_reading(&boxes);
        let out = assemble_lines(&groups, &boxes, |b| {
            if b.quad[0][0] == 0.0 {
                Ok(rec::RecOut {
                    text: "1".to_string(),
                    score: 0.9,
                    centers: vec![0.5],
                })
            } else {
                Ok(rec::RecOut {
                    text: "2".to_string(),
                    score: rec::SCORE_THRESH - 0.1,
                    centers: vec![0.5],
                })
            }
        })
        .expect("assemble");
        assert_eq!(out.text_crlf(), "1");
        assert_eq!(out.lines[0].quads.len(), 1);
        assert!((out.lines[0].score - 0.9).abs() < 1e-6);
    }

    #[test]
    fn tight_wrap_rows_merge_into_one_paragraph() {
        // gap=4 ≤ lo（1.0×median_h）→ 合段；CJK 直连
        let boxes = vec![bx(0, 0, 80, 20), bx(0, 24, 80, 44)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "第一行文字".into()
            } else {
                "紧排续行".into()
            }
        });
        assert_eq!(out.line_count(), 1);
        assert_eq!(out.text_crlf(), "第一行文字紧排续行");
        assert_eq!(out.lines[0].quads.len(), 2);
        assert_eq!(out.lines[0].rows, 2);
    }

    #[test]
    fn large_gap_keeps_two_paragraphs() {
        let boxes = vec![bx(0, 0, 80, 20), bx(0, 60, 80, 80)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "上段".into()
            } else {
                "下段".into()
            }
        });
        assert_eq!(out.line_count(), 2);
        assert_eq!(out.text_crlf(), "上段\r\n\r\n下段");
    }

    #[test]
    fn airy_leading_gray_band_merges_without_terminator() {
        // h=20；gap=28（1.0×h < gap < 1.55×h 灰区）；行尾无句末 → 合段
        let boxes = vec![bx(0, 0, 80, 20), bx(0, 48, 80, 68)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "今日官方也发".into()
            } else {
                "布了一段预告片".into()
            }
        });
        assert_eq!(out.line_count(), 1, "{:?}", out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>());
        assert_eq!(out.text_crlf(), "今日官方也发布了一段预告片");
    }

    #[test]
    fn gray_band_breaks_after_sentence_end() {
        // 同灰区几何，行尾是句末 → 断段
        let boxes = vec![bx(0, 0, 80, 20), bx(0, 48, 80, 68)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "第一句。".into()
            } else {
                "第二句".into()
            }
        });
        assert_eq!(out.line_count(), 2);
        assert_eq!(out.text_crlf(), "第一句。\r\n\r\n第二句");
    }

    #[test]
    fn gray_band_breaks_after_terminator_with_closer() {
        // 句末后带收尾引号/括号也算句末
        let boxes = vec![bx(0, 0, 80, 20), bx(0, 48, 80, 68)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "他说「走。」".into()
            } else {
                "下一句".into()
            }
        });
        assert_eq!(out.line_count(), 2);
    }

    #[test]
    fn dense_wrap_merges_even_after_sentence_end() {
        // gap=8 ≤ lo：紧排 wrap 落在句号后也必须合段
        let boxes = vec![bx(0, 0, 80, 20), bx(0, 28, 80, 48)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "第一句。".into()
            } else {
                "续行".into()
            }
        });
        assert_eq!(out.line_count(), 1);
        assert_eq!(out.text_crlf(), "第一句。续行");
    }

    #[test]
    fn short_rows_do_not_merge_as_continuation() {
        // 居中列表（4.png）：每行短于栏内最宽行（<0.9×W）、均匀小空隙 → 逐行成段
        let boxes = vec![
            bx(50, 0, 150, 20),
            bx(80, 28, 140, 48),
            bx(100, 56, 160, 76),
            bx(100, 84, 160, 104),
            bx(30, 112, 190, 132),
        ];
        let out = run(&boxes, |b| format!("I{}", b.quad[0][1] as i32 / 28));
        assert_eq!(out.line_count(), 5);
        assert_eq!(out.text_crlf(), "I0\r\n\r\nI1\r\n\r\nI2\r\n\r\nI3\r\n\r\nI4");
    }

    #[test]
    fn poster_lines_split_by_full_width_rule() {
        // 3.png 复刻（人工修正为逐行独立）：标题短；满宽行后跟连续短行 → 逐行断（taper）
        let boxes = vec![
            bx(56, 28, 231, 61),
            bx(55, 74, 493, 99),
            bx(53, 115, 431, 148),
            bx(55, 162, 319, 186),
            bx(55, 205, 268, 231),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            28 => "「如何加入」".to_string(),
            74 => "将社媒主页链接+学校+姓名+在读年级".to_string(),
            115 => "发送至邮箱:campus@rokid.com".to_string(),
            162 => "开始时间:2026.09.17起".to_string(),
            _ => "期待你的第一视角！".to_string(),
        });
        assert_eq!(
            out.line_count(),
            5,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].text, "「如何加入」");
        assert_eq!(out.lines[1].text, "将社媒主页链接+学校+姓名+在读年级");
        assert_eq!(out.lines[2].text, "发送至邮箱:campus@rokid.com");
        assert_eq!(out.lines[3].text, "开始时间:2026.09.17起");
        assert_eq!(out.lines[4].text, "期待你的第一视角！");
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![1, 1, 1, 1, 1]
        );
    }

    #[test]
    fn wrapped_pairs_closed_by_gap_outlier_merge() {
        // 12 号复刻：段内紧排（gap 10/14/30）+ 段间离群（48/50）→ 1,1,2,3。
        // 短行对（2585+1874）被「离群大隙 + 满宽起行」闭合 → 是折行段落，不能逐行撕开。
        let boxes = vec![
            bx(0, 23, 344, 121),
            bx(0, 145, 1886, 241),
            bx(0, 291, 2585, 382),
            bx(0, 392, 1874, 484),
            bx(0, 532, 3138, 625),
            bx(0, 639, 3143, 717),
            bx(0, 747, 1036, 816),
        ];
        let out = run(&boxes, |b| format!("r{}", b.quad[0][1] as i32));
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![1, 1, 2, 3],
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn closure_requires_short_pair_not_fullwidth_sentence() {
        // 满宽句末 + 灰区隙 + 后一离群隙 + 再满宽：closure 不得覆盖 v1 句末断
        // （未要求 short_prev/short_next 时会把「结束。」合进下一段）。
        // h=20 → lo=20 / hi=31；gaps 25（灰）/ 50（≥hi，作离群）。
        let boxes = vec![
            bx(0, 0, 800, 20),
            bx(0, 45, 800, 65),
            bx(0, 115, 800, 135),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            0 => "第一段结束。".into(),
            45 => "第二段满宽".into(),
            _ => "第三段满宽".into(),
        });
        assert_eq!(
            out.lines[0].text,
            "第一段结束。",
            "closure 不得吞掉满宽句末断：{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.line_count(), 3);
    }

    #[test]
    fn narrow_tail_in_uniform_spacing_splits() {
        // 13 号复刻：整栏均匀间距（无空隙对比）+ 末行明显窄于上一行 → 独立副标题。
        let boxes = vec![bx(0, 25, 510, 102), bx(0, 137, 277, 218)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 25.0 { "晚上7点来抽夜市" } else { "别忘记来" }.to_string()
        });
        assert_eq!(out.line_count(), 2, "{:?}", out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>());
    }

    #[test]
    fn comma_ended_wrap_tail_merges_despite_narrow_tail() {
        // 用户实例复刻：bullet 标记未被识别、首行以顿号收尾、尾行短 →
        // 句必续（段不能以逗号/顿号收尾），不得被 narrow_tail 撕成两段。
        let boxes = vec![bx(0, 0, 1000, 20), bx(0, 28, 320, 48)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "提交 96888c3：8 文件，+757/−121（tack-ocr v3 聚段、tack-core 共享 punct、V3/V2 文档、".into()
            } else {
                "Cargo.lock）".into()
            }
        });
        assert_eq!(
            out.line_count(),
            1,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].rows, 2);
    }

    #[test]
    fn prose_tail_wrap_with_comma_merges() {
        // 用户实例：满宽行含逗号、未收句；末行短且无句末标点（英文句尾折行）
        // → v3.4 tail：合为一段，不被 narrow_tail 撕开。
        let boxes = vec![bx(0, 0, 1000, 20), bx(0, 28, 300, 48)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                ":love you nats, refuel for the".to_string()
            } else {
                "competition".to_string()
            }
        });
        assert_eq!(
            out.line_count(),
            1,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].rows, 2);
    }

    #[test]
    fn poster_comma_first_line_keeps_short_lines_split() {
        // tail 的证据不跨断点累积：首行含逗号的海报/清单，后续短行仍逐行断（taper/short）。
        let boxes = vec![
            bx(0, 0, 1000, 20),
            bx(0, 28, 500, 48),
            bx(0, 56, 400, 76),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            0 => "欢迎参加活动，一起来玩".to_string(),
            28 => "时间地点另行通知".to_string(),
            _ => "详见海报".to_string(),
        });
        assert_eq!(
            out.line_count(),
            3,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn dangling_word_tail_wrap_merges() {
        // 用户实例 2：英文折行、两行都无标点，但上行以悬空虚词 "be" 收尾（不可能收句）
        // → v3.5 tail 证据：合为一段，不被 narrow_tail（13 号副标题规则）误撕。
        let boxes = vec![bx(0, 0, 1000, 20), bx(0, 28, 300, 48)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "刹那成空- :did you think the neon should be".to_string()
            } else {
                "waeken".to_string()
            }
        });
        assert_eq!(
            out.line_count(),
            1,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].rows, 2);
    }

    #[test]
    fn english_poster_tail_without_dangling_word_splits() {
        // 反面：英文海报式短尾行、上行不以悬空虚词收尾（"code"）→ 仍按 narrow_tail 断。
        let boxes = vec![bx(0, 0, 1000, 20), bx(0, 28, 300, 48)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "Scan the QR code".to_string()
            } else {
                "to join us".to_string()
            }
        });
        assert_eq!(
            out.line_count(),
            2,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn open_pair_across_wrap_merges() {
        // v3.2 配对优先：上行未闭合「（」、下行含「）」→ 合（不依赖逗号/顿号）。
        let boxes = vec![bx(0, 0, 1000, 20), bx(0, 28, 320, 48)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "提交 96888c3（tack-ocr v3 聚段、tack-core 共享 punct".into()
            } else {
                "Cargo.lock）".into()
            }
        });
        assert_eq!(
            out.line_count(),
            1,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].rows, 2);
        // 半/全角混用（OCR 常见）也闭合。
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "提交（tack-ocr v3 聚段、tack-core 共享 punct".into()
            } else {
                "Cargo.lock)".into()
            }
        });
        assert_eq!(out.line_count(), 1);
    }

    #[test]
    fn pair_self_balanced_next_does_not_false_merge() {
        // P1 回归：上行未闭合「（」，下行自身「（…）」成对 → 不得因「含同族闭符号」误合。
        // 几何同 open_pair 用例（末行窄 → narrow_tail）；旧实现会 pair 误合，修复后应断。
        let boxes = vec![bx(0, 0, 1000, 20), bx(0, 28, 320, 48)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "详见说明（未完".into()
            } else {
                "另一段（已完）开头".into()
            }
        });
        assert_eq!(
            out.line_count(),
            2,
            "self-balanced next must not pair-merge: {:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn sentence_end_with_corner_bracket_closer() {
        // is_closer 补齐 】〕｝} 后，行尾「。】」仍是句末（句意分界可用）。
        assert!(line_ends_sentence("第一段结束。】"));
        assert!(line_ends_sentence("第一段结束。}"));
        // gap=28：灰区（< hi=31）但 > lo；靠句末+短下行断，而非空行硬断。
        let boxes = vec![bx(0, 0, 800, 20), bx(0, 48, 400, 68)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "第一段结束。】".into()
            } else {
                "下一段短行".into()
            }
        });
        assert_eq!(
            out.line_count(),
            2,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn marker_rows_start_new_paragraph() {
        // 9 号复刻：满宽紧排、行首 ✅ → 逐项断
        let boxes = vec![
            bx(0, 0, 1000, 20),
            bx(0, 28, 1000, 48),
            bx(0, 56, 990, 76),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            0 => "✅第一项内容".to_string(),
            28 => "✅第二项内容".to_string(),
            _ => "✅第三项内容".to_string(),
        });
        assert_eq!(out.line_count(), 3);
    }

    #[test]
    fn marker_item_wrap_merges_with_item() {
        // 11 号复刻：编号项折行合回条目；下一编号才断
        let boxes = vec![
            bx(0, 0, 1000, 20),
            bx(0, 28, 1000, 48),
            bx(0, 56, 400, 76),
            bx(0, 84, 800, 104),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            0 => "1.第一项".to_string(),
            28 => "2.第二项内容非常长的一行".to_string(),
            56 => "折行内容".to_string(),
            _ => "3.第三项".to_string(),
        });
        assert_eq!(
            out.line_count(),
            3,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![1, 2, 1]
        );
    }

    #[test]
    fn starts_with_marker_rules() {
        assert!(starts_with_marker("✅在读学生"));
        assert!(starts_with_marker("• 项目"));
        assert!(starts_with_marker("· 项目"));
        assert!(starts_with_marker("1.如果"));
        assert!(starts_with_marker("12、条目"));
        assert!(!starts_with_marker("以下仍为基础规则"));
        assert!(!starts_with_marker("1.5 倍的量"));
        assert!(!starts_with_marker("2027年发售"));
    }

    #[test]
    fn taper_guard_skips_prose_short_line_ending_sentence() {
        // 10 号复刻：满宽×2 + 短行（句末）+ 更短行 → 护栏不触发 taper（保持一段）
        let boxes = vec![
            bx(0, 0, 1000, 20),
            bx(0, 28, 1000, 48),
            bx(0, 56, 860, 76),
            bx(0, 84, 800, 104),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            0 => "第一行足够长的一行文字".to_string(),
            28 => "第二行也是满宽的一行文字".to_string(),
            56 => "第三行短一些并且以句号结尾。".to_string(),
            _ => "第四行更短".to_string(),
        });
        assert_eq!(
            out.line_count(),
            2,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].rows, 3);
        assert_eq!(out.lines[1].rows, 1);
    }

    #[test]
    fn tight_sentence_end_with_short_next_breaks() {
        // 8.png 复刻：紧排但上一行以句末结尾、下一行不满宽 → 断（句意 + 版式同向）
        let boxes = vec![bx(0, 10, 613, 31), bx(0, 48, 515, 68)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 10.0 {
                "按理说穆帅的球队一向比较强调战术纪律。以前连德罗巴都要拼命防守。".into()
            } else {
                "如果真的全队跑动距离这么少，可能不是巴配一个人的问题。".into()
            }
        });
        assert_eq!(out.line_count(), 2, "{:?}", out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>());
    }

    #[test]
    fn tight_sentence_end_with_full_next_still_merges() {
        // 紧排 + 上一行句末但下一行满宽 → 仍是段内 wrap（换行恰落在句号后）
        let boxes = vec![bx(0, 0, 80, 20), bx(0, 28, 80, 48), bx(0, 56, 80, 76)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "第一句。".into()
            } else {
                "续行".into()
            }
        });
        assert_eq!(out.line_count(), 1);
    }

    #[test]
    fn line_ends_sentence_rules() {
        assert!(line_ends_sentence("话说完。"));
        assert!(line_ends_sentence("结束! "));
        assert!(line_ends_sentence("结束？"));
        assert!(line_ends_sentence("他说「走。」"));
        assert!(line_ends_sentence("等等……"));
        assert!(!line_ends_sentence("还没说完"));
        assert!(!line_ends_sentence("值为3.14"));
        assert!(!line_ends_sentence("未完（"));
        // v3：分号是句内继续，不是句末。
        assert!(!line_ends_sentence("甲分句；"));
        assert!(!line_ends_sentence("未完，"));
        // v3：缩写点 / 首字母链不算句末。
        assert!(!line_ends_sentence("Mr."));
        assert!(!line_ends_sentence("他说 Mr."));
        assert!(!line_ends_sentence("等等 etc."));
        assert!(!line_ends_sentence("见 U.S."));
        assert!(!line_ends_sentence("J. K."));
        assert!(!line_ends_sentence("他说 Rev."));
        assert!(!line_ends_sentence("Barnes & Bros."));
        // 单个字母不在链里：仍是句末。
        assert!(line_ends_sentence("答案是 A."));
        // 列表标记点不算句末；数字前是汉字则仍是句末（共享 punct，与选句同源）。
        assert!(!line_ends_sentence("1."));
        assert!(line_ends_sentence("答案是第1."));
    }

    #[test]
    fn semicolon_is_intra_sentence() {
        // 灰区隙（h=20，gap=28）+ 上一行分号收尾 + 下一行满宽收句 → 合（v1 会按句末断）。
        let boxes = vec![bx(0, 0, 80, 20), bx(0, 48, 80, 68)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "甲分句；".into()
            } else {
                "乙分句收尾。".into()
            }
        });
        assert_eq!(out.line_count(), 1);
        assert_eq!(out.text_crlf(), "甲分句；乙分句收尾。");
    }

    #[test]
    fn sentence_continuation_merges_short_tail() {
        // 16 号复刻：首行满宽且未收句（"若要"），末行短但以句号收尾 → v3 句意续接合段，
        // 不被 narrow_tail（13 号补丁）撕开。
        let boxes = vec![bx(0, 43, 3432, 139), bx(0, 150, 1271, 229)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 43.0 {
                "前半段还没说完若要".into()
            } else {
                "后半段收尾即可。".into()
            }
        });
        assert_eq!(
            out.line_count(),
            1,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].rows, 2);
        assert_eq!(out.lines[0].text, "前半段还没说完若要后半段收尾即可。");
    }

    #[test]
    fn sentence_boundary_gap_outlier_breaks() {
        // 17 号复刻：满宽句末 + 段距（76）明显大于本栏折行距（18）→ 断；
        // 随后第二句折行按句意续接合回 → 1,2。
        let boxes = vec![
            bx(0, 35, 3330, 110),
            bx(0, 186, 3361, 269),
            bx(0, 287, 1097, 368),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            35 => "第一句到此结束。".to_string(),
            186 => "第二句的前半还没".to_string(),
            _ => "说完即可。".to_string(),
        });
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![1, 2],
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].text, "第一句到此结束。");
        assert_eq!(out.lines[1].text, "第二句的前半还没说完即可。");
    }

    #[test]
    fn mid_sentence_wrap_with_punct_evidence_merges() {
        // 用户实例（case 18）：满宽散文折行，第 3 行「…establishment and」略窄（0.86 满宽），
        // 上下两侧都是句中且行内有逗号 → v3.3 标点优先判续接，不被 short 撕成两段。
        let boxes = vec![
            bx(0, 0, 1000, 20),
            bx(0, 28, 1000, 48),
            bx(0, 56, 860, 76),
            bx(0, 84, 1000, 104),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            0 => "The two leaders acknowledged the positive role of the China-US economic and".to_string(),
            28 => "trade consultation mechanism, and recognized the outcomes achieved by their".to_string(),
            56 => "respective economic and trade teams, namely the establishment and".to_string(),
            _ => "advancement of such mechanisms as a trade council, a 30-billion-US-dollar".to_string(),
        });
        assert_eq!(
            out.line_count(),
            1,
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].rows, 4);
    }

    #[test]
    fn no_punct_run_stays_geometric() {
        // 无任何标点的折行短句（诗/海报）：mid 无标点痕迹不触发，仍按 short 几何断
        // （15 号形状 1,3 锁死）。v3.6 eq_cjk 要求等宽，本形状宽度比 ≫ 1.05，不触发。
        let boxes = vec![
            bx(0, 35, 348, 136),
            bx(0, 162, 616, 271),
            bx(0, 299, 609, 401),
            bx(0, 426, 569, 536),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            35 => "我如果爱你".to_string(),
            162 => "绝不像攀援的凌霄花".to_string(),
            299 => "借你的高枝炫耀自己".to_string(),
            _ => "甚至日光 甚至春雨".to_string(),
        });
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![1, 3],
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn equal_width_short_cjk_hard_breaks_each_row() {
        // case 14 形状：4 行等宽五言、均匀紧隙、无标点 → eq_cjk 硬断为 1,1,1,1。
        let boxes = vec![
            bx(0, 20, 110, 40),
            bx(0, 64, 109, 84),
            bx(0, 108, 107, 128),
            bx(0, 152, 108, 172),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            20 => "床前明月光".to_string(),
            64 => "疑是地上霜".to_string(),
            108 => "举头望明月".to_string(),
            _ => "低头思故乡".to_string(),
        });
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![1, 1, 1, 1],
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(out.lines[0].text, "床前明月光");
        assert_eq!(out.lines[3].text, "低头思故乡");
    }

    #[test]
    fn equal_width_long_cjk_still_merges() {
        // 等宽但每行 CJK > 7：不触发 eq_cjk，均匀紧隙仍走 default 合为一段。
        let boxes = vec![
            bx(0, 20, 200, 40),
            bx(0, 64, 198, 84),
            bx(0, 108, 199, 128),
            bx(0, 152, 197, 172),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            20 => "今日官方也发了一段".to_string(), // 9
            64 => "预告片内容非常精彩".to_string(), // 9
            108 => "大家可以先看一眼".to_string(), // 8
            _ => "然后再决定要不要".to_string(), // 8
        });
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![4],
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn equal_width_punctuated_cjk_does_not_eq_cjk() {
        // 等宽短行但含句内标点 → 不触发 eq_cjk；均匀紧隙满宽走 default 合为一段。
        let boxes = vec![
            bx(0, 20, 110, 40),
            bx(0, 64, 109, 84),
            bx(0, 108, 107, 128),
            bx(0, 152, 108, 172),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            20 => "床前，月光".to_string(),
            64 => "疑是、地上".to_string(),
            108 => "举头望明月".to_string(),
            _ => "低头思故乡".to_string(),
        });
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![4],
            "punctuated equal-width must stay geometric merge, not eq_cjk: {:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn equal_width_seven_cjk_chars_still_eq_cjk() {
        // 上界 7 字仍触发 eq_cjk（与 >7 的 long 用例成对）。
        let boxes = vec![
            bx(0, 20, 140, 40),
            bx(0, 64, 139, 84),
            bx(0, 108, 138, 128),
            bx(0, 152, 137, 172),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            20 => "床前明月光光光".to_string(), // 7
            64 => "疑是地上霜霜霜".to_string(),
            108 => "举头望明月月月".to_string(),
            _ => "低头思故乡乡乡".to_string(),
        });
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![1, 1, 1, 1],
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn equal_width_mixed_latin_does_not_eq_cjk() {
        // 去空白后混入拉丁 → 拒绝 eq_cjk；等宽紧隙仍 default 合。
        let boxes = vec![
            bx(0, 20, 110, 40),
            bx(0, 64, 109, 84),
            bx(0, 108, 107, 128),
            bx(0, 152, 108, 172),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            20 => "床前ABC光".to_string(),
            64 => "疑是DEF霜".to_string(),
            108 => "举头GHI月".to_string(),
            _ => "低头JKL乡".to_string(),
        });
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![4],
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn equal_width_hard_gap_skips_eq_cjk() {
        // 中间 gap ≥ hi：不走整栏 eq_cjk；硬断后两侧各自 default 合 → 2,2。
        // median_h≈20 → hi≈31；gap 80 ≫ hi。
        let boxes = vec![
            bx(0, 20, 110, 40),
            bx(0, 64, 109, 84),
            bx(0, 200, 107, 220),
            bx(0, 244, 108, 264),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            20 => "床前明月光".to_string(),
            64 => "疑是地上霜".to_string(),
            200 => "举头望明月".to_string(),
            _ => "低头思故乡".to_string(),
        });
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![2, 2],
            "hard gap must skip column eq_cjk: {:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn equal_width_list_marker_does_not_eq_cjk() {
        // 等宽短行但有列表标记 → 不触发整栏 eq_cjk（标记行走 hard）。
        let boxes = vec![
            bx(0, 20, 110, 40),
            bx(0, 64, 109, 84),
            bx(0, 108, 107, 128),
            bx(0, 152, 108, 172),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            20 => "1.床前明".to_string(),
            64 => "2.疑是地".to_string(),
            108 => "3.举头望".to_string(),
            _ => "4.低头思".to_string(),
        });
        // 标记硬断 → 每行独立，但路径不是 eq_cjk；形状仍应为 1,1,1,1。
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![1, 1, 1, 1],
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn semicolon_ended_row_not_mid_merged() {
        // 12 号护栏：行尾「；」是列表项边界，即使下行满宽且行内有逗号/顿号也不走 mid。
        let boxes = vec![
            bx(0, 0, 1000, 20),
            bx(0, 28, 1000, 48),
            bx(0, 56, 620, 76),
            bx(0, 84, 1000, 104),
        ];
        let out = run(&boxes, |b| match b.quad[0][1] as i32 {
            0 => "第一行满宽未收句".to_string(),
            28 => "第二行也是满宽的一行".to_string(),
            56 => "第三行收尾分号；".to_string(),
            _ => "第四行满宽，含有逗号、顿号".to_string(),
        });
        assert_eq!(
            out.lines.iter().map(|l| l.rows).collect::<Vec<_>>(),
            vec![3, 1],
            "{:?}",
            out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn blank_gap_breaks_even_with_continuation_evidence() {
        // 空行是硬断：即使文本显示句中断行（OCR 丢标点场景），仍以版式为准（登记 miss 方向）。
        let boxes = vec![bx(0, 0, 80, 20), bx(0, 60, 80, 80)]; // gap=40 ≥ hi=31
        let out = run(&boxes, |b| {
            if b.quad[0][1] == 0.0 {
                "上半句还没说完".into()
            } else {
                "下半句收尾。".into()
            }
        });
        assert_eq!(out.line_count(), 2);
    }

    #[test]
    fn tableish_rows_do_not_merge_vertically() {
        // 3 行 × 2 列；列缝 < order gutter 阈值，避免被拆成双栏；行间紧排但表感禁合段
        let mut boxes = Vec::new();
        for row in 0..3i32 {
            let y = row * 24;
            boxes.push(bx(0, y, 40, y + 20));
            boxes.push(bx(55, y, 95, y + 20)); // gap=15 < GAP_MIN_PX
        }
        let out = run(&boxes, |b| {
            let col = if b.quad[0][0] < 50.0 { "A" } else { "B" };
            let r = (b.quad[0][1] as i32) / 24;
            format!("{col}{r}")
        });
        assert_eq!(out.line_count(), 3, "{:?}", out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>());
        assert_eq!(out.lines[0].text, "A0 B0");
        assert_eq!(out.lines[1].text, "A1 B1");
        assert_eq!(out.lines[2].text, "A2 B2");
    }

    #[test]
    fn join_texts_rules() {

        assert_eq!(join_texts(&["1", "2", "3"]), "1 2 3");
        assert_eq!(join_texts(&["你", "好"]), "你好");
        assert_eq!(join_texts(&["你好", "，世界"]), "你好，世界");
        assert_eq!(join_texts(&["abc", "你好"]), "abc 你好");
        assert_eq!(join_texts(&["foo ", "bar"]), "foo bar");
        assert_eq!(join_texts(&["foo", " bar"]), "foo bar");
    }

    #[test]
    fn large_selection_threshold() {
        assert!(!is_large_selection(800, 600));
        assert!(is_large_selection(1921, 100));
        assert!(is_large_selection(2000, 2000));
    }

    #[test]
    fn box_spans_same_row_ascii_spaces() {
        let boxes: Vec<DetBox> = (1..=3)
            .map(|i| bx(i * 100, 0, i * 100 + 40, 20))
            .collect();
        let out = run(&boxes, |b| format!("{}", b.quad[0][0] as i32 / 100));
        assert_eq!(out.lines[0].text, "1 2 3");
        let spans = &out.lines[0].box_spans;
        assert_eq!(spans.len(), 3);
        assert_eq!((spans[0].utf16_start, spans[0].utf16_end), (0, 1));
        assert_eq!((spans[1].utf16_start, spans[1].utf16_end), (2, 3));
        assert_eq!((spans[2].utf16_start, spans[2].utf16_end), (4, 5));
    }

    #[test]
    fn box_spans_cjk_no_space_and_range_query() {
        let boxes = vec![bx(0, 0, 20, 20), bx(20, 0, 40, 20)];
        let out = run(&boxes, |b| {
            if b.quad[0][0] < 10.0 {
                "你".into()
            } else {
                "好。".into()
            }
        });
        assert_eq!(out.lines[0].text, "你好。");
        let spans = &out.lines[0].box_spans;
        assert_eq!(spans.len(), 2);
        assert_eq!((spans[0].utf16_start, spans[0].utf16_end), (0, 1));
        assert_eq!((spans[1].utf16_start, spans[1].utf16_end), (1, 3));
        let card = out.card_utf16();
        assert_eq!(card.len(), 3);
        let q0 = out.quads_for_utf16_range(0, 1);
        assert_eq!(q0.len(), 1);
        let q_all = out.quads_for_utf16_range(0, 3);
        assert_eq!(q_all.len(), 2);
        let q_sent = out.quads_for_utf16_range(0, 3);
        assert_eq!(q_sent, out.lines[0].quads);
    }

    #[test]
    fn quads_for_utf16_across_paragraphs() {
        let out = OcrOutput {
            lines: vec![
                OcrLine {
                    text: "甲。".into(),
                    score: 1.0,
                    rows: 1,
                    quads: vec![[[0., 0.], [10., 0.], [10., 10.], [0., 10.]]],
                    box_spans: vec![BoxSpan {
                        utf16_start: 0,
                        utf16_end: 2,
                        quad: [[0., 0.], [10., 0.], [10., 10.], [0., 10.]],
                        row: 0,
                        char_x: vec![0.25, 0.75],
                    }],
                },
                OcrLine {
                    text: "乙。".into(),
                    score: 1.0,
                    rows: 1,
                    quads: vec![[[0., 40.], [10., 40.], [10., 50.], [0., 50.]]],
                    box_spans: vec![BoxSpan {
                        utf16_start: 0,
                        utf16_end: 2,
                        quad: [[0., 40.], [10., 40.], [10., 50.], [0., 50.]],
                        row: 0,
                        char_x: vec![0.25, 0.75],
                    }],
                },
            ],
        };
        let card = out.card_utf16();
        // 甲。\n\n乙。
        assert_eq!(card.len(), 2 + 2 + 2);
        let only_second = out.quads_for_utf16_range(4, 6);
        assert_eq!(only_second.len(), 1);
        assert_eq!(only_second[0][0][1], 40.0);
        assert!(out.quads_for_utf16_range(2, 4).is_empty()); // 落在段间空行
    }

    #[test]
    fn box_spans_survive_paragraph_merge() {
        // 两行紧排 CJK 合段后 span 覆盖全文且无重叠空洞。
        let boxes = vec![
            bx(0, 0, 80, 18),
            bx(0, 20, 80, 38),
        ];
        let out = run(&boxes, |b| {
            if b.quad[0][1] < 10.0 {
                "第一行文字".into()
            } else {
                "第二行文字。".into()
            }
        });
        assert_eq!(out.line_count(), 1);
        let line = &out.lines[0];
        assert_eq!(line.box_spans.len(), 2);
        assert_eq!(line.box_spans[0].utf16_start, 0);
        assert_eq!(line.box_spans[1].utf16_end, utf16_len(&line.text));
        assert_eq!(line.box_spans[0].utf16_end, line.box_spans[1].utf16_start);
        let card = out.card_utf16();
        let q = out.quads_for_utf16_range(0, card.len());
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn scale_back_covers_quads_and_box_spans() {
        let quad = [[0.0, 0.0], [30.0, 0.0], [30.0, 15.0], [0.0, 15.0]];
        let mut out = OcrOutput {
            lines: vec![OcrLine {
                text: "甲".into(),
                score: 1.0,
                rows: 1,
                quads: vec![quad],
                box_spans: vec![BoxSpan {
                    utf16_start: 0,
                    utf16_end: 1,
                    quad,
                    row: 0,
                    char_x: vec![0.5],
                }],
            }],
        };
        scale_geometry_to_original(&mut out, 3);
        assert_eq!(
            out.lines[0].quads[0],
            [[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [0.0, 5.0]]
        );
        assert_eq!(out.lines[0].box_spans[0].quad, out.lines[0].quads[0]);
    }

    #[test]
    fn highlight_merges_same_row_fragments() {
        let boxes = vec![bx(0, 0, 40, 20), bx(50, 0, 200, 20)];
        let out = run(&boxes, |b| {
            if b.quad[0][0] < 10.0 {
                "已用".into()
            } else {
                "TACK".into()
            }
        });
        assert_eq!(out.line_count(), 1);
        assert_eq!(out.lines[0].box_spans.len(), 2);
        assert_eq!(out.lines[0].box_spans[0].row, out.lines[0].box_spans[1].row);
        let card = out.card_utf16();
        let rects = out.highlight_rects_for_utf16_range(0, card.len());
        assert_eq!(rects, vec![hr(0.0, 0.0, 200.0, 20.0)]);
        // 只选第二片：单段、单矩形，不含第一片。
        let only_second = out.highlight_rects_for_utf16_range(3, 7);
        assert_eq!(only_second, vec![hr(50.0, 0.0, 200.0, 20.0)]);
    }

    #[test]
    fn highlight_bridges_wrapped_rows_in_one_paragraph() {
        let boxes = vec![bx(0, 0, 80, 18), bx(0, 20, 80, 38)];
        let out = run(&boxes, |b| {
            if b.quad[0][1] < 10.0 {
                "第一行文字".into()
            } else {
                "第二行文字。".into()
            }
        });
        assert_eq!(out.line_count(), 1);
        assert_eq!(out.lines[0].box_spans[0].row, 0);
        assert_eq!(out.lines[0].box_spans[1].row, 1);
        let card = out.card_utf16();
        let rects = out.highlight_rects_for_utf16_range(0, card.len());
        assert_eq!(
            rects,
            vec![
                hr(0.0, 0.0, 80.0, 18.0),
                hr(0.0, 18.0, 80.0, 20.0),
                hr(0.0, 20.0, 80.0, 38.0),
            ]
        );
    }

    #[test]
    fn highlight_does_not_bridge_across_paragraphs() {
        let out = OcrOutput {
            lines: vec![
                OcrLine {
                    text: "甲。".into(),
                    score: 1.0,
                    rows: 1,
                    quads: vec![[[0., 0.], [10., 0.], [10., 10.], [0., 10.]]],
                    box_spans: vec![BoxSpan {
                        utf16_start: 0,
                        utf16_end: 2,
                        quad: [[0., 0.], [10., 0.], [10., 10.], [0., 10.]],
                        row: 0,
                        char_x: vec![0.25, 0.75],
                    }],
                },
                OcrLine {
                    text: "乙。".into(),
                    score: 1.0,
                    rows: 1,
                    quads: vec![[[0., 12.], [10., 12.], [10., 22.], [0., 22.]]],
                    box_spans: vec![BoxSpan {
                        utf16_start: 0,
                        utf16_end: 2,
                        quad: [[0., 12.], [10., 12.], [10., 22.], [0., 22.]],
                        row: 0,
                        char_x: vec![0.25, 0.75],
                    }],
                },
            ],
        };
        let card = out.card_utf16();
        let rects = out.highlight_rects_for_utf16_range(0, card.len());
        assert_eq!(
            rects,
            vec![hr(0.0, 0.0, 10.0, 10.0), hr(0.0, 12.0, 10.0, 22.0)]
        );
    }

    #[test]
    fn highlight_clips_partial_span_by_char_positions() {
        // 单框四字：char_x 均匀；选区落在框内部时按字位裁剪。
        let quad = [[0., 0.], [40., 0.], [40., 10.], [0., 10.]];
        let out = OcrOutput {
            lines: vec![OcrLine {
                text: "甲乙丙丁".into(),
                score: 1.0,
                rows: 1,
                quads: vec![quad],
                box_spans: vec![BoxSpan {
                    utf16_start: 0,
                    utf16_end: 4,
                    quad,
                    row: 0,
                    char_x: vec![0.125, 0.375, 0.625, 0.875],
                }],
            }],
        };
        let card = out.card_utf16();
        // 全句：不裁。
        assert_eq!(
            out.highlight_rects_for_utf16_range(0, card.len()),
            vec![hr(0., 0., 40., 10.)]
        );
        // 选「乙丙」：左边界 = mid(0.125,0.375)=0.25，右边界 = mid(0.625,0.875)=0.75。
        assert_eq!(
            out.highlight_rects_for_utf16_range(1, 3),
            vec![hr_c(10., 0., 30., 10., true, true)]
        );
        // 选「甲乙」：右边界 = mid(0.375,0.625)=0.5。
        assert_eq!(
            out.highlight_rects_for_utf16_range(0, 2),
            vec![hr_c(0., 0., 20., 10., false, true)]
        );
        // 选「丙丁」：左边界 = 0.5。
        assert_eq!(
            out.highlight_rects_for_utf16_range(2, 4),
            vec![hr_c(20., 0., 40., 10., true, false)]
        );
        // 无字位数据：回退整框（两边都不裁）。
        let mut no_pos = out.clone();
        no_pos.lines[0].box_spans[0].char_x.clear();
        assert_eq!(
            no_pos.highlight_rects_for_utf16_range(1, 3),
            vec![hr(0., 0., 40., 10.)]
        );
    }

    #[test]
    fn highlight_clip_follows_rotated_quad_axis() {
        // 平行四边形（轻微斜切）：裁剪沿阅读轴插值，不是 AABB 直切。
        let quad = [[10., 0.], [50., 0.], [40., 20.], [0., 20.]];
        let out = OcrOutput {
            lines: vec![OcrLine {
                text: "甲乙".into(),
                score: 1.0,
                rows: 1,
                quads: vec![quad],
                box_spans: vec![BoxSpan {
                    utf16_start: 0,
                    utf16_end: 2,
                    quad,
                    row: 0,
                    char_x: vec![0.25, 0.75],
                }],
            }],
        };
        // 只选后一字：t0 = mid(0.25,0.75)=0.5，t1=1。
        assert_eq!(
            out.highlight_rects_for_utf16_range(1, 2),
            vec![hr_c(20., 0., 50., 20., true, false)]
        );
    }

    fn models_dir() -> Option<PathBuf> {
        // 仅认 TACK_OCR_MODELS；勿硬编码开发机路径。
        let dir = PathBuf::from(std::env::var("TACK_OCR_MODELS").ok()?);
        dir.join("det.rten").is_file().then_some(dir)
    }

    #[test]
    fn load_and_blank_image_if_models_present() {
        let Some(dir) = models_dir() else {
            return;
        };
        let engine = Engine::load(&dir).expect("load models");
        let w = 64u32;
        let h = 32u32;
        let mut bgra = vec![255u8; (w * h * 4) as usize];
        for px in bgra.chunks_exact_mut(4) {
            px[3] = 255;
        }
        let out = engine.recognize_bgra(&bgra, w, h).expect("recognize");
        assert_eq!(out.line_count(), 0);
    }
}
