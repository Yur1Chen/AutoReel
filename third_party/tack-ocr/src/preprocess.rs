use rten_tensor::NdTensor;

use crate::OcrError;

const DET_SIDE: f32 = 1080.0;
const DET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const DET_STD: [f32; 3] = [0.229, 0.224, 0.225];
const REC_H: u32 = 48;
const REC_MAX_W: u32 = 3200;

pub fn det_tensor(bgra: &[u8], w: u32, h: u32) -> Result<(NdTensor<f32, 4>, f32, f32), OcrError> {
    check_bgra(bgra, w, h)?;
    let max_side = w.max(h) as f32;
    let scale = if max_side > DET_SIDE {
        DET_SIDE / max_side
    } else {
        1.0
    };
    // 先按最长边限幅，再对齐 32；回映到原图像素必须用实际 nw/w、nh/h，
    // 不能沿用限幅前的单一 scale（四舍五入后宽高比会漂）。
    let nw = ((((w as f32 * scale) / 32.0).round() as u32).max(1)) * 32;
    let nh = ((((h as f32 * scale) / 32.0).round() as u32).max(1)) * 32;
    let t = resize_nchw(bgra, w, h, nw, nh, DET_MEAN, DET_STD);
    Ok((t, nw as f32 / w as f32, nh as f32 / h as f32))
}

pub fn rec_tensor(
    bgra: &[u8],
    w: u32,
    h: u32,
    quad: &[[f32; 2]; 4],
) -> Result<NdTensor<f32, 4>, OcrError> {
    check_bgra(bgra, w, h)?;
    if !quad.iter().all(|p| p[0].is_finite() && p[1].is_finite()) {
        return Err(OcrError::CropEmpty);
    }
    let dst_w = quad_side(&quad[0], &quad[1]).max(quad_side(&quad[2], &quad[3]));
    let dst_h = quad_side(&quad[0], &quad[3]).max(quad_side(&quad[1], &quad[2]));
    if dst_w < 1.0 || dst_h < 1.0 {
        return Err(OcrError::CropEmpty);
    }
    let dst_w = dst_w.ceil().clamp(1.0, REC_MAX_W as f32);
    let dst_h = dst_h.ceil();
    let tw = ((dst_w * REC_H as f32 / dst_h).ceil() as u32).clamp(1, REC_MAX_W);
    Ok(warp_quad_nchw(bgra, w, h, quad, tw, REC_H))
}

fn quad_side(a: &[f32; 2], b: &[f32; 2]) -> f32 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    (dx * dx + dy * dy).sqrt()
}

/// N× 双三次（Catmull-Rom）上采样 BGRA8；越界采样 clamp 到边缘。
/// 目的：细笔画/小字在 rec 归一化到 48px 前先放大，避免 1px 灰线被
/// 双线性糊掉（机制与实验见 `docs/OCR-ACCURACY-PIPELINE-2026-09-21.md` §7）。
///
/// 行级并行（`std::thread::scope`）：每像素独立，与串行逐字节一致；
/// 小图（输出 < 256 行）走串行，避免建线程开销。不改核/倍率/触发条件。
pub fn upscale_bgra(bgra: &[u8], w: u32, h: u32, factor: u32) -> Vec<u8> {
    let f = factor.max(1);
    if f == 1 {
        return bgra.to_vec();
    }
    let (w, h) = (w as usize, h as usize);
    let (ow, oh) = (w * f as usize, h * f as usize);
    let mut out = vec![0u8; ow * oh * 4];
    let inv = 1.0 / f as f32;
    // 输出行数少时串行更省；阈值取输出高，与倍率无关。
    const PARALLEL_MIN_ROWS: usize = 256;
    if oh < PARALLEL_MIN_ROWS {
        upscale_rows(bgra, w, h, ow, 0..oh, inv, &mut out);
    } else {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2)
            .clamp(2, 8)
            .min(oh);
        let chunk = oh.div_ceil(threads);
        std::thread::scope(|scope| {
            let mut rest = out.as_mut_slice();
            let mut y = 0usize;
            while y < oh {
                let end = (y + chunk).min(oh);
                let (slice, next) = rest.split_at_mut((end - y) * ow * 4);
                // `slice` 对应输出行 [y, end)；传入绝对行号区间。
                let y0 = y;
                scope.spawn(move || {
                    upscale_rows(bgra, w, h, ow, y0..end, inv, slice);
                });
                rest = next;
                y = end;
            }
        });
    }
    out
}

/// 将输出行区间 `oy_range` 写入 `out_rows`（长度必须 = 行数 × ow × 4）。
fn upscale_rows(
    bgra: &[u8],
    w: usize,
    h: usize,
    ow: usize,
    oy_range: std::ops::Range<usize>,
    inv: f32,
    out_rows: &mut [u8],
) {
    let sample = |x: i64, y: i64, c: usize| -> f32 {
        let xi = x.clamp(0, w as i64 - 1) as usize;
        let yi = y.clamp(0, h as i64 - 1) as usize;
        bgra[(yi * w + xi) * 4 + c] as f32
    };
    let y_base = oy_range.start;
    for oy in oy_range.clone() {
        let sy = (oy as f32 + 0.5) * inv - 0.5;
        let y0 = sy.floor() as i64;
        let fy = sy - y0 as f32;
        let wy: [f32; 4] = std::array::from_fn(|j| cubic_weight(j as f32 - (fy + 1.0)));
        let row_off = (oy - y_base) * ow * 4;
        for ox in 0..ow {
            let sx = (ox as f32 + 0.5) * inv - 0.5;
            let x0 = sx.floor() as i64;
            let fx = sx - x0 as f32;
            let wx: [f32; 4] = std::array::from_fn(|i| cubic_weight(i as f32 - (fx + 1.0)));
            let mut acc = [0f32; 4];
            let mut wsum = 0f32;
            for (j, &wyj) in wy.iter().enumerate() {
                for (i, &wxi) in wx.iter().enumerate() {
                    let wgt = wxi * wyj;
                    wsum += wgt;
                    for (c, accc) in acc.iter_mut().enumerate() {
                        *accc += wgt * sample(x0 + i as i64 - 1, y0 + j as i64 - 1, c);
                    }
                }
            }
            let idx = row_off + ox * 4;
            for (c, accc) in acc.iter().enumerate() {
                out_rows[idx + c] = (accc / wsum).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Catmull-Rom（a = -0.5）核：`d` 为到采样点的距离。
fn cubic_weight(d: f32) -> f32 {
    let d = d.abs();
    if d <= 1.0 {
        1.5 * d * d * d - 2.5 * d * d + 1.0
    } else if d < 2.0 {
        -0.5 * d * d * d + 2.5 * d * d - 4.0 * d + 2.0
    } else {
        0.0
    }
}

fn check_bgra(bgra: &[u8], w: u32, h: u32) -> Result<(), OcrError> {
    if w == 0 || h == 0 {
        return Err(OcrError::BadImageSize);
    }
    let expected = w as usize * h as usize * 4;
    if bgra.len() != expected {
        return Err(OcrError::PixelSizeMismatch);
    }
    Ok(())
}

fn warp_quad_nchw(
    bgra: &[u8],
    w: u32,
    h: u32,
    quad: &[[f32; 2]; 4],
    dw: u32,
    dh: u32,
) -> NdTensor<f32, 4> {
    let mut t = NdTensor::<f32, 4>::zeros([1, 3, dh as usize, dw as usize]);
    let du = if dw > 1 { (dw - 1) as f32 } else { 1.0 };
    let dv = (dh - 1) as f32;
    for y in 0..dh {
        let v = y as f32 / dv;
        for x in 0..dw {
            let u = x as f32 / du;
            let mut sx = 0.0f32;
            let mut sy = 0.0f32;
            for (i, p) in quad.iter().enumerate() {
                let wu = match i {
                    0 => (1.0 - u) * (1.0 - v),
                    1 => u * (1.0 - v),
                    2 => u * v,
                    _ => (1.0 - u) * v,
                };
                sx += wu * p[0];
                sy += wu * p[1];
            }
            let rgb = sample_rgb(bgra, w, h, sx, sy);
            for c in 0..3 {
                t[[0, c, y as usize, x as usize]] = (rgb[c] - 0.5) / 0.5;
            }
        }
    }
    t
}

fn resize_nchw(
    bgra: &[u8],
    sw: u32,
    sh: u32,
    dw: u32,
    dh: u32,
    mean: [f32; 3],
    std: [f32; 3],
) -> NdTensor<f32, 4> {
    let mut t = NdTensor::<f32, 4>::zeros([1, 3, dh as usize, dw as usize]);
    let swf = sw as f32;
    let shf = sh as f32;
    let dwf = dw as f32;
    let dhf = dh as f32;
    for y in 0..dh {
        let sy = (y as f32 + 0.5) * shf / dhf - 0.5;
        for x in 0..dw {
            let sx = (x as f32 + 0.5) * swf / dwf - 0.5;
            let rgb = sample_rgb(bgra, sw, sh, sx, sy);
            for c in 0..3 {
                t[[0, c, y as usize, x as usize]] = (rgb[c] - mean[c]) / std[c];
            }
        }
    }
    t
}

fn sample_rgb(bgra: &[u8], w: u32, h: u32, fx: f32, fy: f32) -> [f32; 3] {
    let x0 = fx.floor() as i32;
    let y0 = fy.floor() as i32;
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let c00 = rgb_at(bgra, w, h, x0, y0);
    let c10 = rgb_at(bgra, w, h, x0 + 1, y0);
    let c01 = rgb_at(bgra, w, h, x0, y0 + 1);
    let c11 = rgb_at(bgra, w, h, x0 + 1, y0 + 1);
    let mut out = [0.0f32; 3];
    for i in 0..3 {
        let a = c00[i] + (c10[i] - c00[i]) * tx;
        let b = c01[i] + (c11[i] - c01[i]) * tx;
        out[i] = a + (b - a) * ty;
    }
    out
}

fn rgb_at(bgra: &[u8], w: u32, h: u32, x: i32, y: i32) -> [f32; 3] {
    let x = x.clamp(0, w as i32 - 1) as usize;
    let y = y.clamp(0, h as i32 - 1) as usize;
    let i = (y * w as usize + x) * 4;
    [
        bgra[i + 2] as f32 / 255.0,
        bgra[i + 1] as f32 / 255.0,
        bgra[i] as f32 / 255.0,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use rten_tensor::prelude::*;

    #[test]
    fn det_rejects_bad_len() {
        assert!(det_tensor(&[0; 4], 2, 2).is_err());
    }

    #[test]
    fn det_scales_match_resized_dims() {
        let px = vec![0u8; 100 * 50 * 4];
        let (t, sx, sy) = det_tensor(&px, 100, 50).expect("det");
        let shape = t.shape();
        assert_eq!(shape[0], 1);
        assert_eq!(shape[1], 3);
        let nw = shape[3] as f32;
        let nh = shape[2] as f32;
        assert!((sx - nw / 100.0).abs() < 1e-6);
        assert!((sy - nh / 50.0).abs() < 1e-6);
        assert_eq!(shape[3] % 32, 0);
        assert_eq!(shape[2] % 32, 0);
    }

    #[test]
    fn det_side_1080_keeps_within_and_clamps_over() {
        let px = vec![0u8; 1920 * 1080 * 4];
        let (t, _, _) = det_tensor(&px, 1920, 1080).expect("det");
        let shape = t.shape();
        assert_eq!(shape[3], 1088);
        assert_eq!(shape[2], 608);

        let small = vec![0u8; 800 * 400 * 4];
        let (t, _, _) = det_tensor(&small, 800, 400).expect("det");
        let shape = t.shape();
        assert_eq!(shape[3], 800);
        assert_eq!(shape[2], 416);

        let big = vec![0u8; 2560 * 1440 * 4];
        let (t, _, _) = det_tensor(&big, 2560, 1440).expect("det");
        let shape = t.shape();
        assert_eq!(shape[3], 1088);
        assert_eq!(shape[2], 608);
    }

    #[test]
    fn rec_quad_empty_fails() {
        let px = vec![0u8; 8 * 8 * 4];
        let degenerate = [[100.0, 100.0]; 4];
        assert!(rec_tensor(&px, 8, 8, &degenerate).is_err());
        let non_finite = [[f32::NAN, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        assert!(rec_tensor(&px, 8, 8, &non_finite).is_err());
    }

    #[test]
    fn rec_near_axis_dims_match_aabb_crop() {
        let px = vec![128u8; 64 * 24 * 4];
        let quad = [[0.0, 0.0], [64.0, 0.0], [64.0, 24.0], [0.0, 24.0]];
        let t = rec_tensor(&px, 64, 24, &quad).expect("rec");
        let shape = t.shape();
        assert_eq!(shape[2], 48);
        assert_eq!(shape[3], 128);
    }

    #[test]
    fn upscale_doubles_dims_and_keeps_constant_color() {
        let bgra = vec![10u8, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255];
        let out = upscale_bgra(&bgra, 2, 2, 2);
        assert_eq!(out.len(), 4 * 4 * 4);
        for px in out.chunks_exact(4) {
            assert_eq!(px, &[10, 20, 30, 255]);
        }
        let out3 = upscale_bgra(&bgra, 2, 2, 3);
        assert_eq!(out3.len(), 6 * 6 * 4);
        let same = upscale_bgra(&bgra, 2, 2, 1);
        assert_eq!(same, bgra);
    }

    #[test]
    fn upscale_bright_dot_stays_central() {
        let mut bgra = vec![0u8; 4 * 4 * 4];
        let i = (2 * 4 + 2) * 4;
        bgra[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
        let out = upscale_bgra(&bgra, 4, 4, 2);
        let mut best = (0usize, 0usize, 0u32);
        for y in 0..8 {
            for x in 0..8 {
                let v = out[(y * 8 + x) * 4] as u32;
                if v > best.2 {
                    best = (x, y, v);
                }
            }
        }
        assert!(best.0 >= 4 && best.0 <= 6 && best.1 >= 4 && best.1 <= 6, "best={best:?}");
    }

    /// 输出高 ≥256 走并行路径；常数色应与串行小图路径一致（逐字节可复现）。
    #[test]
    fn upscale_parallel_path_keeps_constant_color() {
        let (w, h) = (64u32, 96u32); // 3× → 192×288，oh=288 ≥ 256
        let bgra = vec![10u8, 20, 30, 255]
            .into_iter()
            .cycle()
            .take((w * h * 4) as usize)
            .collect::<Vec<_>>();
        let out = upscale_bgra(&bgra, w, h, 3);
        assert_eq!(out.len(), (w * 3 * h * 3 * 4) as usize);
        for px in out.chunks_exact(4) {
            assert_eq!(px, &[10, 20, 30, 255]);
        }
    }

    /// `TACK_OCR_UPSCALE_BENCH=1` 时打印若干尺寸的上采样耗时（默认直接 return，不进 CI 噪音）。
    #[test]
    fn upscale_timings_print_when_env_set() {
        if std::env::var("TACK_OCR_UPSCALE_BENCH").as_deref() != Ok("1") {
            return;
        }
        let cases = [(400u32, 300u32, 3u32), (800, 600, 3), (1920, 1080, 3)];
        for (w, h, f) in cases {
            let bgra = vec![128u8; (w * h * 4) as usize];
            let _ = upscale_bgra(&bgra, w, h, f);
            let n = 3u32;
            let t0 = std::time::Instant::now();
            for _ in 0..n {
                let _ = upscale_bgra(&bgra, w, h, f);
            }
            let ms = t0.elapsed().as_secs_f64() * 1e3 / n as f64;
            eprintln!("upscale_bench {w}x{h} x{f} avg_ms={ms:.1} out={}x{}", w * f, h * f);
        }
    }
}
