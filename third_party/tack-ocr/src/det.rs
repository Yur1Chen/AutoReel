use std::cmp::Ordering;

use rten_tensor::prelude::*;
use rten_tensor::NdTensor;

const DB_THRESH: f32 = 0.2;
const BOX_THRESH: f32 = 0.45;
const UNCLIP_RATIO: f32 = 1.6;
const MIN_EDGE: f32 = 3.0;
const MIN_SIDE: f32 = 5.0;

#[derive(Clone, Debug)]
pub struct DetBox {
    pub quad: [[f32; 2]; 4],
    #[allow(dead_code)]
    pub score: f32,
}

pub fn db_boxes(
    prob: &NdTensor<f32, 4>,
    scale_x: f32,
    scale_y: f32,
    ow: u32,
    oh: u32,
) -> Vec<DetBox> {
    let h = prob.shape()[2];
    let w = prob.shape()[3];
    let get = |x: usize, y: usize| prob[[0, 0, y, x]];
    let mut visited = vec![false; w * h];
    let mut boxes = Vec::new();
    let mut stack: Vec<(usize, usize)> = Vec::new();
    for sy in 0..h {
        for sx in 0..w {
            if visited[sy * w + sx] || get(sx, sy) <= DB_THRESH {
                continue;
            }
            let mut minx = sx;
            let mut maxx = sx;
            let mut miny = sy;
            let mut maxy = sy;
            let mut sum = 0.0f64;
            let mut count = 0usize;
            let mut points: Vec<[f32; 2]> = Vec::new();
            stack.clear();
            stack.push((sx, sy));
            visited[sy * w + sx] = true;
            while let Some((x, y)) = stack.pop() {
                sum += get(x, y) as f64;
                count += 1;
                points.push([x as f32, y as f32]);
                if x < minx {
                    minx = x;
                }
                if x > maxx {
                    maxx = x;
                }
                if y < miny {
                    miny = y;
                }
                if y > maxy {
                    maxy = y;
                }
                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = x as i32 + dx;
                        let ny = y as i32 + dy;
                        if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                            continue;
                        }
                        let (nx, ny) = (nx as usize, ny as usize);
                        if !visited[ny * w + nx] && get(nx, ny) > DB_THRESH {
                            visited[ny * w + nx] = true;
                            stack.push((nx, ny));
                        }
                    }
                }
            }
            let bw = (maxx - minx + 1) as f32;
            let bh = (maxy - miny + 1) as f32;
            if bw < MIN_EDGE || bh < MIN_EDGE {
                continue;
            }
            let score = (sum / count as f64) as f32;
            if score < BOX_THRESH {
                continue;
            }
            let falls_back = || {
                [
                    [minx as f32, miny as f32],
                    [maxx as f32, miny as f32],
                    [maxx as f32, maxy as f32],
                    [minx as f32, maxy as f32],
                ]
            };
            let rect = min_area_rect(&points).unwrap_or_else(falls_back);
            let expanded = unclip_quad(&rect, UNCLIP_RATIO);
            let mut quad = [[0.0f32; 2]; 4];
            for (i, p) in expanded.iter().enumerate() {
                quad[i] = [
                    (p[0] / scale_x).clamp(0.0, (ow - 1) as f32),
                    (p[1] / scale_y).clamp(0.0, (oh - 1) as f32),
                ];
            }
            if shortest_side(&quad) < MIN_SIDE {
                continue;
            }
            boxes.push(DetBox {
                quad: order_corners(quad),
                score,
            });
        }
    }
    boxes
}

fn dist(a: &[f32; 2], b: &[f32; 2]) -> f32 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    (dx * dx + dy * dy).sqrt()
}

pub(crate) fn shortest_side(quad: &[[f32; 2]; 4]) -> f32 {
    (0..4)
        .map(|i| dist(&quad[i], &quad[(i + 1) % 4]))
        .fold(f32::INFINITY, f32::min)
}

fn signed_area(quad: &[[f32; 2]; 4]) -> f32 {
    let mut s = 0.0f32;
    for i in 0..4 {
        let p = quad[i];
        let q = quad[(i + 1) % 4];
        s += p[0] * q[1] - q[0] * p[1];
    }
    s * 0.5
}

pub(crate) fn convex_hull(points: &[[f32; 2]]) -> Vec<[f32; 2]> {
    let mut pts: Vec<[f32; 2]> = points.to_vec();
    pts.sort_by(|a, b| {
        a[0].partial_cmp(&b[0])
            .unwrap_or(Ordering::Equal)
            .then(a[1].partial_cmp(&b[1]).unwrap_or(Ordering::Equal))
    });
    pts.dedup();
    if pts.len() < 3 {
        return Vec::new();
    }
    let cross = |o: &[f32; 2], a: &[f32; 2], b: &[f32; 2]| {
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    };
    let mut hull: Vec<[f32; 2]> = Vec::with_capacity(pts.len() * 2);
    for p in &pts {
        while hull.len() >= 2 && cross(&hull[hull.len() - 2], &hull[hull.len() - 1], p) <= 0.0 {
            hull.pop();
        }
        hull.push(*p);
    }
    let lower = hull.len() + 1;
    for p in pts.iter().rev().skip(1) {
        while hull.len() >= lower
            && cross(&hull[hull.len() - 2], &hull[hull.len() - 1], p) <= 0.0
        {
            hull.pop();
        }
        hull.push(*p);
    }
    hull.pop();
    if hull.len() < 3 {
        return Vec::new();
    }
    let mut q: Vec<[f32; 2]> = hull;
    let area: f32 = {
        let mut s = 0.0f32;
        for i in 0..q.len() {
            let a = q[i];
            let b = q[(i + 1) % q.len()];
            s += a[0] * b[1] - b[0] * a[1];
        }
        s * 0.5
    };
    if area < 0.0 {
        q.reverse();
    }
    q
}

pub(crate) fn min_area_rect(points: &[[f32; 2]]) -> Option<[[f32; 2]; 4]> {
    let hull = convex_hull(points);
    if hull.len() < 3 {
        return None;
    }
    let n = hull.len();
    let mut best_area = f32::INFINITY;
    let mut best: Option<[[f32; 2]; 4]> = None;
    for i in 0..n {
        let p = hull[i];
        let q = hull[(i + 1) % n];
        let (ex, ey) = (q[0] - p[0], q[1] - p[1]);
        let len = (ex * ex + ey * ey).sqrt();
        if len < 1e-6 {
            continue;
        }
        let (ex, ey) = (ex / len, ey / len);
        let (nx, ny) = (-ey, ex);
        let mut umin = f32::INFINITY;
        let mut umax = f32::NEG_INFINITY;
        let mut vmin = f32::INFINITY;
        let mut vmax = f32::NEG_INFINITY;
        for pt in &hull {
            let dx = pt[0] - p[0];
            let dy = pt[1] - p[1];
            let u = dx * ex + dy * ey;
            let v = dx * nx + dy * ny;
            umin = umin.min(u);
            umax = umax.max(u);
            vmin = vmin.min(v);
            vmax = vmax.max(v);
        }
        let area = (umax - umin) * (vmax - vmin);
        if area < best_area {
            best_area = area;
            best = Some([
                [p[0] + umin * ex + vmin * nx, p[1] + umin * ey + vmin * ny],
                [p[0] + umax * ex + vmin * nx, p[1] + umax * ey + vmin * ny],
                [p[0] + umax * ex + vmax * nx, p[1] + umax * ey + vmax * ny],
                [p[0] + umin * ex + vmax * nx, p[1] + umin * ey + vmax * ny],
            ]);
        }
    }
    if best_area <= 1e-6 {
        return None;
    }
    best
}

pub(crate) fn unclip_quad(quad: &[[f32; 2]; 4], ratio: f32) -> [[f32; 2]; 4] {
    let mut q = *quad;
    if signed_area(&q) < 0.0 {
        q.reverse();
    }
    let mut area2 = 0.0f32;
    let mut perimeter = 0.0f32;
    for i in 0..4 {
        let p = q[i];
        let n = q[(i + 1) % 4];
        area2 += p[0] * n[1] - n[0] * p[1];
        perimeter += dist(&p, &n);
    }
    let area = area2.abs() * 0.5;
    if perimeter < 1e-6 {
        return q;
    }
    let d = area * ratio / perimeter;
    let mut out = q;
    for i in 0..4 {
        let p = q[i];
        let n = q[(i + 1) % 4];
        let (dx, dy) = (n[0] - p[0], n[1] - p[1]);
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-6 {
            continue;
        }
        let (ox, oy) = (dy / len, -dx / len);
        out[i][0] += ox * d;
        out[i][1] += oy * d;
        out[(i + 1) % 4][0] += ox * d;
        out[(i + 1) % 4][1] += oy * d;
    }
    out
}

fn order_corners(q: [[f32; 2]; 4]) -> [[f32; 2]; 4] {
    let mut idx = [0usize, 1, 2, 3];
    idx.sort_by(|&a, &b| {
        q[a][0]
            .partial_cmp(&q[b][0])
            .unwrap_or(Ordering::Equal)
            .then(q[a][1].partial_cmp(&q[b][1]).unwrap_or(Ordering::Equal))
    });
    let (a, b) = (idx[0], idx[1]);
    let (c, d) = (idx[2], idx[3]);
    let (tl, bl) = if q[a][1] <= q[b][1] { (a, b) } else { (b, a) };
    let (tr, br) = if q[c][1] <= q[d][1] { (c, d) } else { (d, c) };
    [q[tl], q[tr], q[br], q[bl]]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect_points(w: f32, h: f32, angle: f32, ox: f32, oy: f32) -> Vec<[f32; 2]> {
        let (s, c) = angle.sin_cos();
        let mut pts = Vec::new();
        for y in 0..=(h as i32) {
            for x in 0..=(w as i32) {
                let (fx, fy) = (x as f32, y as f32);
                pts.push([c * fx - s * fy + ox, s * fx + c * fy + oy]);
            }
        }
        pts
    }

    #[test]
    fn axis_aligned_min_area_rect_matches_aabb() {
        let pts = rect_points(20.0, 10.0, 0.0, 5.0, 7.0);
        let q = min_area_rect(&pts).expect("rect");
        let mut xs: Vec<f32> = q.iter().map(|p| p[0]).collect();
        let mut ys: Vec<f32> = q.iter().map(|p| p[1]).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for &x in &xs {
            assert!(
                (x - 5.0).abs() <= 1.0 || (x - 25.0).abs() <= 1.0,
                "x={x} 不在 AABB 角上"
            );
        }
        for &y in &ys {
            assert!(
                (y - 7.0).abs() <= 1.0 || (y - 17.0).abs() <= 1.0,
                "y={y} 不在 AABB 角上"
            );
        }
    }

    #[test]
    fn rotated_min_area_rect_area_and_side() {
        let pts = rect_points(40.0, 10.0, 30f32.to_radians(), 100.0, 50.0);
        let q = min_area_rect(&pts).expect("rect");
        let area = signed_area(&q).abs();
        let expect_area = 40.0 * 10.0;
        assert!(
            (area - expect_area).abs() / expect_area < 0.05,
            "area={area}"
        );
        let short = shortest_side(&q);
        assert!((short - 10.0).abs() / 10.0 < 0.05, "short={short}");
    }

    #[test]
    fn min_area_rect_degenerate_is_none() {
        assert!(min_area_rect(&[]).is_none());
        assert!(min_area_rect(&[[1.0, 1.0], [2.0, 2.0]]).is_none());
        assert!(min_area_rect(&[[0.0, 0.0], [1.0, 1.0], [2.0, 2.0], [3.0, 3.0]]).is_none());
    }

    #[test]
    fn unclip_expands_bbox_by_two_d() {
        let quad = [[0.0, 0.0], [40.0, 0.0], [40.0, 10.0], [0.0, 10.0]];
        let d = 40.0 * 10.0 * 1.4 / (2.0 * (40.0 + 10.0));
        let out = unclip_quad(&quad, 1.4);
        let xs: Vec<f32> = out.iter().map(|p| p[0]).collect();
        let ys: Vec<f32> = out.iter().map(|p| p[1]).collect();
        let (minx, maxx) = (
            xs.iter().cloned().fold(f32::INFINITY, f32::min),
            xs.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
        );
        let (miny, maxy) = (
            ys.iter().cloned().fold(f32::INFINITY, f32::min),
            ys.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
        );
        assert!((maxx - minx - (40.0 + 2.0 * d)).abs() < 1e-3);
        assert!((maxy - miny - (10.0 + 2.0 * d)).abs() < 1e-3);
        assert!((minx + d).abs() < 1e-3 && (miny + d).abs() < 1e-3);
    }

    #[test]
    fn order_corners_is_tl_tr_br_bl() {
        let q = order_corners([[10.0, 10.0], [0.0, 0.0], [0.0, 10.0], [10.0, 0.0]]);
        assert_eq!(q[0], [0.0, 0.0]);
        assert_eq!(q[1], [10.0, 0.0]);
        assert_eq!(q[2], [10.0, 10.0]);
        assert_eq!(q[3], [0.0, 10.0]);
    }
}
