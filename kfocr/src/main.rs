//! 用 tack-ocr 识别一张或多张图片，打印每行文本 + 框坐标。
//!
//! 用法：
//!   kfocr <图片> [<图片2> ...]      单张或少量图片
//!   kfocr --list <文件>             每行一个图片路径，模型只加载一次
//!   kfocr --marker <比例> --list <文件>
//!                                   只采样「行首淡黄像素占比」，不做 OCR（供 JS 引擎判本机 ID）
//!   kfocr --stats --list <文件>     只算像素特征，不做 OCR（校准前置过滤阈值用）
//!
//! 选项：
//!   --models <目录>                 模型目录（也读环境变量 TACK_OCR_MODELS；两者都没有就报错退出）
//!   --no-prefilter                  关掉前置空槽/底色过滤（A/B 用）
//!   --no-dedup                      关掉帧间去重（A/B 用）
//!   --prefilter-min <比例>          前置过滤的「击杀条像素占比」阈值，默认 0.04
//!   --dedup-max <比例>              判定两帧相同的平均绝对差上限（0–1），默认 0.012
//!
//! 批量模式（图片数 > 1）下，每张图之前先输出一行 `F<TAB><路径>` 作为分组标记，
//! 其后是该图的识别结果：
//!   i \t y0 \t y1 \t x0 \t x1 \t score \t text
//!
//! 性能（docs/BENCHMARKS.md）：
//!   1. 前置过滤： killings 条只在屏幕上有击杀时才存在。一帧裁剪图里若几乎没有击杀条
//!      的底色/文字/图标像素，就直接跳过推理——空槽占绝大多数帧（实测 720 帧里 499 帧
//!      没有任何文本），这一步砍掉的是纯浪费。
//!   2. 帧间去重：击杀条一行停留 4–5s，2fps 下连续 6–10 帧内容几乎不变。把上一帧降采样
//!      成 32×8 灰度块算平均绝对差（MAD），够像就直接复用上一帧的识别结果，不再推理。
//!      去重只在同一槽位（同一父目录）内做，槽位切换时自然不成立。

use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 特征采样的步长：760×50 的裁剪图按 2 采样只剩 ~9.5k 个点，微秒级。
const FEAT_STRIDE: u32 = 2;
/// 帧间去重的降采样尺寸（宽 × 高）。
const GRAY_W: usize = 32;
const GRAY_H: usize = 8;

fn usage() {
    eprintln!("用法:");
    eprintln!("  kfocr <图片> [<图片2> ...]");
    eprintln!("  kfocr --list <文件>            # 每行一个图片路径");
    eprintln!("  kfocr --marker <比例> --list <文件>  # 只算行首黄框占比，输出 M<TAB>路径<TAB>百分比");
    eprintln!("  kfocr --stats --list <文件>     # 只算像素特征（校准前置过滤用）");
    eprintln!("  kfocr --models <目录> ...      # 指定模型目录（也可用环境变量 TACK_OCR_MODELS）");
    eprintln!("  --no-prefilter / --no-dedup    # 关掉前置过滤 / 帧间去重（A/B 用）");
    eprintln!("  --prefilter-min <比例>         # 击杀条底色占比低于它就算空槽，默认 0.06");
    eprintln!("  --prefilter-yellow <比例>      # 行首金框兜底：有金框就不算空槽，默认 0.01");
    eprintln!("  --dedup-max <比例>             # 帧间 MAD 上限，默认 0.012");
}

// 一行击杀条裁剪图里「行首淡黄像素」的占比（%）。
//
// 游戏用淡黄色画本机玩家的头像框：R/G 高、B 低、R≈G。和 PowerShell 版
// Get-SelfMarkerScore 的采样与阈值逐条对齐（同样的步长 3、同样的 xMax 取整），
// 这样两个引擎判出来的本机 ID 才可能一致。
fn marker_score(img: &image::RgbaImage, fraction: f64, stride: u32) -> f64 {
    let x_max = (img.width() as f64 * fraction) as u32;
    let mut hit: u64 = 0;
    let mut tot: u64 = 0;
    for px in (0..x_max).step_by(stride as usize) {
        for py in (0..img.height()).step_by(stride as usize) {
            let p = img.get_pixel(px, py);
            let (r, g, b) = (p[0] as i32, p[1] as i32, p[2] as i32);
            tot += 1;
            if r >= 185 && g >= 185 && b <= 165 && (r - b) >= 55 && (g - b) >= 55 && (r - g).abs() <= 35 {
                hit += 1;
            }
        }
    }
    if tot == 0 {
        return 0.0;
    }
    100.0 * hit as f64 / tot as f64
}

/// 一帧裁剪图的廉价像素特征（不做推理，纯扫描）。
///
/// 击杀条是「队伍色底 + 白字 + 深色描边」的实心面板：本机/队友侧是青绿，敌方侧是红，
/// 本机玩家那一行行首还有淡黄头像框。空白槽位露出的是游戏画面，蓝通道普遍偏低、
/// 也不会有大面积近白像素，因此这几个比例天然分开（阈值见 `Feat::is_empty`）。
#[derive(Default, Clone, Copy)]
struct Feat {
    n: u32,
    ink: u32,
    teal: u32,
    red: u32,
    yellow: u32,
    dark: u32,
    sum_luma: f64,
}

impl Feat {
    fn frac(&self, v: u32) -> f64 {
        if self.n == 0 {
            0.0
        } else {
            v as f64 / self.n as f64
        }
    }
    /// 击杀条底色（青绿 + 红）占比：面板在不在屏幕上的主判据。
    fn color(&self) -> f64 {
        self.frac(self.teal + self.red)
    }
    /// 击杀条要素总占比（底色 + 白字 + 深描边）。只用于统计输出。
    #[allow(dead_code)]
    fn panel(&self) -> f64 {
        self.frac(self.teal + self.red + self.ink)
    }
    fn mean_luma(&self) -> f64 {
        if self.n == 0 {
            0.0
        } else {
            self.sum_luma / self.n as f64
        }
    }
    /// 判空：击杀条根本没在屏幕上，直接跳过推理。
    ///
    /// 两个条件同时不成立才算空——底色没有、行首金框也没有。金框是「本机在杀手位」最强的信号
    /// （实测真击杀帧最低 0.0239），拿它做兜底，即使哪天击杀条底色判据失灵（换配色/滤镜），
    /// 也不会把真击杀帧当空槽丢掉。误判成「有内容」只是多跑一次推理，代价可接受；
    /// 反过来误判成空槽会直接丢击杀，所以这里宁松勿紧。
    fn is_empty(&self, min_color: f64, min_yellow: f64) -> bool {
        self.color() < min_color && self.frac(self.yellow) < min_yellow
    }
}

fn analyze(img: &image::RgbaImage) -> Feat {
    let mut f = Feat::default();
    for py in (0..img.height()).step_by(FEAT_STRIDE as usize) {
        for px in (0..img.width()).step_by(FEAT_STRIDE as usize) {
            let p = img.get_pixel(px, py);
            let (r, g, b) = (p[0] as i32, p[1] as i32, p[2] as i32);
            let max = r.max(g).max(b);
            let min = r.min(g).min(b);
            f.n += 1;
            f.sum_luma += 0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64;
            // 白字：三通道都高且接近无彩（聚类的名字是纯白，带一点抗锯齿）
            if min >= 190 && (max - min) <= 45 {
                f.ink += 1;
            }
            // 队伍色底：青绿（G/B 高、R 明显低）
            if g >= 130 && b >= 120 && r <= 130 && (g - r) >= 35 && (b - r) >= 20 {
                f.teal += 1;
            }
            // 敌方色底：红（R 高、G/B 低）
            if r >= 140 && g <= 100 && b <= 100 && (r - g) >= 50 {
                f.red += 1;
            }
            // 行首金框（与 marker_score 同一套判据）
            if r >= 185 && g >= 185 && b <= 165 && (r - b) >= 55 && (g - b) >= 55 && (r - g).abs() <= 35 {
                f.yellow += 1;
            }
            // 深色描边/面板阴影
            if max <= 70 {
                f.dark += 1;
            }
        }
    }
    f
}

/// 把图像降采样成 GRAY_W×GRAY_H 的灰度块，用于帧间平均绝对差（MAD）。
fn gray_blocks(img: &image::RgbaImage) -> Vec<f32> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w == 0 || h == 0 {
        return vec![0.0; GRAY_W * GRAY_H];
    }
    let mut sum = vec![0f64; GRAY_W * GRAY_H];
    let mut cnt = vec![0u32; GRAY_W * GRAY_H];
    for y in 0..h {
        let by = y * GRAY_H / h;
        for x in 0..w {
            let bx = x * GRAY_W / w;
            let p = img.get_pixel(x as u32, y as u32);
            let luma = 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
            let i = by * GRAY_W + bx;
            sum[i] += luma;
            cnt[i] += 1;
        }
    }
    (0..GRAY_W * GRAY_H)
        .map(|i| if cnt[i] == 0 { 0.0 } else { (sum[i] / cnt[i] as f64) as f32 })
        .collect()
}

/// 两个灰度块的平均绝对差（0–1）。
fn mad(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 1.0;
    }
    let mut acc = 0f64;
    for i in 0..a.len() {
        acc += (a[i] - b[i]).abs() as f64;
    }
    (acc / a.len() as f64 / 255.0) as f32
}

/// 上一帧的识别结果与灰度块：去重命中时直接复用，不再推理。
struct FrameCache {
    /// 所属槽位（取父目录，槽位之间互不相干）
    group: PathBuf,
    gray: Vec<f32>,
    /// 该帧识别到的行（TSV 的 i/坐标/score/text 原文，逐行）
    lines: Vec<String>,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut images: Vec<PathBuf> = Vec::new();
    let mut models: Option<PathBuf> = None;
    let mut list: Option<PathBuf> = None;
    let mut quiet = false;
    let mut marker: Option<f64> = None;
    let mut stats = false;
    let mut prefilter = true;
    let mut dedup = true;
    let mut prefilter_min = 0.06f64;
    let mut prefilter_yellow = 0.01f64;
    let mut dedup_max = 0.012f64;

    while let Some(a) = args.next() {
        match a.as_str() {
            "--quiet" | "-q" => quiet = true,
            "--no-prefilter" => prefilter = false,
            "--no-dedup" => dedup = false,
            "--stats" => stats = true,
            "--prefilter-min" => match args.next().and_then(|s| s.parse::<f64>().ok()) {
                Some(x) if (0.0..=1.0).contains(&x) => prefilter_min = x,
                _ => {
                    eprintln!("--prefilter-min 需要 0–1 的比例");
                    std::process::exit(2);
                }
            },
            "--prefilter-yellow" => match args.next().and_then(|s| s.parse::<f64>().ok()) {
                Some(x) if (0.0..=1.0).contains(&x) => prefilter_yellow = x,
                _ => {
                    eprintln!("--prefilter-yellow 需要 0–1 的比例");
                    std::process::exit(2);
                }
            },
            "--dedup-max" => match args.next().and_then(|s| s.parse::<f64>().ok()) {
                Some(x) if (0.0..=1.0).contains(&x) => dedup_max = x,
                _ => {
                    eprintln!("--dedup-max 需要 0–1 的比例");
                    std::process::exit(2);
                }
            },
            "--models" => {
                models = args.next().map(PathBuf::from);
                if models.is_none() {
                    eprintln!("--models 缺少参数");
                    std::process::exit(2);
                }
            }
            "--marker" => {
                let v = args.next();
                match v.as_deref().and_then(|s| s.parse::<f64>().ok()) {
                    Some(x) if x > 0.0 && x <= 1.0 => marker = Some(x),
                    _ => {
                        eprintln!("--marker 需要一个 (0,1] 的比例，例如 --marker 0.5");
                        std::process::exit(2);
                    }
                }
            }
            "--list" => {
                list = args.next().map(PathBuf::from);
                if list.is_none() {
                    eprintln!("--list 缺少参数");
                    std::process::exit(2);
                }
            }
            "-h" | "--help" => {
                usage();
                return;
            }
            _ => images.push(PathBuf::from(a)),
        }
    }

    if let Some(l) = list {
        let file = match std::fs::File::open(&l) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("打开列表失败 {}: {e}", l.display());
                std::process::exit(2);
            }
        };
        for line in BufReader::new(file).lines() {
            let line = line.unwrap_or_default();
            let p = line.trim();
            if !p.is_empty() {
                images.push(PathBuf::from(p));
            }
        }
    }

    // 兼容旧用法：kfocr <图片> <模型目录>
    if models.is_none() && images.len() == 2 && images[1].is_dir() {
        models = images.pop();
    }

    if images.is_empty() {
        usage();
        std::process::exit(2);
    }

    // --marker：纯像素采样，不加载模型（省一次模型加载，也让 JS 引擎不依赖 OCR 模型）
    if let Some(fraction) = marker {
        let stdout = std::io::stdout();
        let mut out = BufWriter::new(stdout.lock());
        for img_path in &images {
            match image::open(img_path) {
                Ok(img) => {
                    let rgba = img.to_rgba8();
                    let score = marker_score(&rgba, fraction, 3);
                    let _ = writeln!(out, "M\t{}\t{score:.3}", img_path.display());
                }
                Err(e) => eprintln!("[skip] {}: {e}", img_path.display()),
            }
        }
        let _ = out.flush();
        return;
    }

    // --stats：只算特征，不加载模型、不推理。用来对着标注集校准前置过滤阈值。
    if stats {
        let stdout = std::io::stdout();
        let mut out = BufWriter::new(stdout.lock());
        for img_path in &images {
            match image::open(img_path) {
                Ok(img) => {
                    let rgba = img.to_rgba8();
                    let f = analyze(&rgba);
                    let _ = writeln!(
                        out,
                        "S\t{}\t{}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.1}",
                        img_path.display(),
                        f.n,
                        f.frac(f.ink),
                        f.frac(f.teal),
                        f.frac(f.red),
                        f.frac(f.yellow),
                        f.frac(f.dark),
                        f.color(),
                        f.mean_luma()
                    );
                }
                Err(e) => eprintln!("[skip] {}: {e}", img_path.display()),
            }
        }
        let _ = out.flush();
        return;
    }

    let models = models
        .or_else(|| {
            std::env::var_os("TACK_OCR_MODELS")
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
        })
        .unwrap_or_else(|| {
            eprintln!("找不到 OCR 模型目录：请用 --models <目录> 指定，或设置环境变量 TACK_OCR_MODELS。");
            eprintln!("  目录里需要 det.rten / rec.rten / ppocrv6_dict.txt（PP-OCRv6 Small，Apache-2.0）。");
            std::process::exit(2);
        });

    if !models.is_dir() {
        eprintln!("OCR 模型目录不存在: {}", models.display());
        std::process::exit(2);
    }

    let t0 = Instant::now();
    let engine = tack_ocr::Engine::load(&models).expect("加载模型失败");
    eprintln!(
        "[load] {:.0}ms  models={} images={}",
        t0.elapsed().as_secs_f64() * 1e3,
        models.display(),
        images.len()
    );

    let batch = images.len() > 1;
    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    let mut skipped_empty = 0usize;
    let mut skipped_dup = 0usize;
    let mut recognized = 0usize;
    let mut cache: Option<FrameCache> = None;

    let t_all = Instant::now();
    for img_path in &images {
        if batch {
            // 分组标记，脚本按它切分每张图的结果
            let _ = writeln!(out, "F\t{}", img_path.display());
        }

        let img = match image::open(img_path) {
            Ok(i) => i,
            Err(e) => {
                eprintln!("[skip] {}: {e}", img_path.display());
                continue;
            }
        };
        let rgba = img.to_rgba8();
        let (w, h) = (rgba.width(), rgba.height());

        // 槽位 = 父目录。槽位切换时上一帧的缓存一定不能用（不同 ROI，内容不相干）。
        let group = img_path.parent().unwrap_or(Path::new("")).to_path_buf();
        let same_group = cache.as_ref().is_some_and(|c| c.group == group);

        // ① 帧间去重：先算降采样灰度块，够像就复用上一帧结果，省掉一次推理。
        let gray = gray_blocks(&rgba);
        if dedup && same_group {
            if let Some(c) = cache.as_ref() {
                let d = mad(&gray, &c.gray);
                if d <= dedup_max as f32 {
                    skipped_dup += 1;
                    for line in &c.lines {
                        let _ = writeln!(out, "{line}");
                    }
                    cache = Some(FrameCache { group, gray, lines: c.lines.clone() });
                    continue;
                }
            }
        }

        // ② 前置过滤：屏幕上根本没有击杀条就不必推理。
        let feat = analyze(&rgba);
        if prefilter && feat.is_empty(prefilter_min, prefilter_yellow) {
            skipped_empty += 1;
            cache = Some(FrameCache { group, gray, lines: Vec::new() });
            continue;
        }

        let mut bgra = rgba.into_raw();
        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
        }

        let t1 = Instant::now();
        let res = match engine.recognize_bgra(&bgra, w, h) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[skip] {}: {e}", img_path.display());
                continue;
            }
        };
        if !quiet {
            eprintln!(
                "[ocr] {:.0}ms  lines={}  {}x{}  {}",
                t1.elapsed().as_secs_f64() * 1e3,
                res.lines.len(),
                w,
                h,
                img_path.display()
            );
        }
        recognized += 1;
        let mut lines = Vec::with_capacity(res.lines.len());
        for (i, line) in res.lines.iter().enumerate() {
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for q in &line.quads {
                for p in q {
                    x0 = x0.min(p[0]);
                    y0 = y0.min(p[1]);
                    x1 = x1.max(p[0]);
                    y1 = y1.max(p[1]);
                }
            }
            // TSV：i \t y0 \t y1 \t x0 \t x1 \t score \t text
            let row = format!(
                "{i}\t{y0:.1}\t{y1:.1}\t{x0:.1}\t{x1:.1}\t{:.3}\t{}",
                line.score, line.text
            );
            let _ = writeln!(out, "{row}");
            lines.push(row);
        }
        cache = Some(FrameCache { group, gray, lines });
    }
    let _ = out.flush();

    let el = t_all.elapsed().as_secs_f64();
    if batch {
        if !quiet {
            eprintln!(
                "[batch] {} 张 {:.1}s 均值 {:.1}ms/张",
                images.len(),
                el,
                el * 1e3 / images.len() as f64
            );
        }
        // 过滤统计不受 --quiet 影响：它是「省了多少推理」的唯一说明，脚本要把它透出去
        if skipped_empty > 0 || skipped_dup > 0 {
            eprintln!(
                "[filter] 推理 {} 张  跳过 {} 张（空槽 {} / 帧间重复 {}）  均值 {:.1}ms/张（按全量算）",
                recognized,
                skipped_empty + skipped_dup,
                skipped_empty,
                skipped_dup,
                el * 1e3 / images.len() as f64
            );
        }
    }
}
