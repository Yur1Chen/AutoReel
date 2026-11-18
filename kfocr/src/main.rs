//! 用 tack-ocr 识别一张或多张图片，打印每行文本 + 框坐标。
//!
//! 用法：
//!   kfocr <图片> [<图片2> ...]      单张或少量图片
//!   kfocr --list <文件>             每行一个图片路径，模型只加载一次
//!   kfocr --marker <比例> --list <文件>
//!                                   只采样「行首淡黄像素占比」，不做 OCR（供 JS 引擎判本机 ID）
//!
//! 选项：
//!   --models <目录>                 模型目录（也读环境变量 TACK_OCR_MODELS；两者都没有就报错退出）
//!
//! 批量模式（图片数 > 1）下，每张图之前先输出一行 `F<TAB><路径>` 作为分组标记，
//! 其后是该图的识别结果：
//!   i \t y0 \t y1 \t x0 \t x1 \t score \t text

use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::time::Instant;

fn usage() {
    eprintln!("用法:");
    eprintln!("  kfocr <图片> [<图片2> ...]");
    eprintln!("  kfocr --list <文件>            # 每行一个图片路径");
    eprintln!("  kfocr --marker <比例> --list <文件>  # 只算行首黄框占比，输出 M<TAB>路径<TAB>百分比");
    eprintln!("  kfocr --models <目录> ...      # 指定模型目录（也可用环境变量 TACK_OCR_MODELS）");
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

fn main() {
    let mut args = std::env::args().skip(1);
    let mut images: Vec<PathBuf> = Vec::new();
    let mut models: Option<PathBuf> = None;
    let mut list: Option<PathBuf> = None;
    let mut quiet = false;
    let mut marker: Option<f64> = None;

    while let Some(a) = args.next() {
        match a.as_str() {
            "--quiet" | "-q" => quiet = true,
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
            let _ = writeln!(
                out,
                "{i}\t{y0:.1}\t{y1:.1}\t{x0:.1}\t{x1:.1}\t{:.3}\t{}",
                line.score, line.text
            );
        }
    }
    let _ = out.flush();

    if batch {
        let el = t_all.elapsed().as_secs_f64();
        if !quiet {
            eprintln!(
                "[batch] {} 张 {:.1}s 均值 {:.1}ms/张",
                images.len(),
                el,
                el * 1e3 / images.len() as f64
            );
        }
    }
}
