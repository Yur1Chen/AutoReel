use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::det::DetBox;

const ROW_OVERLAP_MIN: f32 = 0.5;
const GAP_MIN_PX: f32 = 24.0;
const GAP_MED_RATIO: f32 = 2.0;
const BUCKET_W: f32 = 16.0;
const GUTTER_ROWS_MIN: usize = 3;

#[derive(Clone, Copy)]
struct Aabb {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

struct Row {
    idxs: Vec<usize>,
    y0: i32,
    y1: i32,
}

/// 视觉行：同一栏内 y 重叠的一串框（`idxs` 为输入 `boxes` 下标，已按 x 排序）。
pub struct ReadingRow {
    pub idxs: Vec<usize>,
}

/// 一栏：若干视觉行，按从上到下。
pub struct ReadingColumn {
    pub rows: Vec<ReadingRow>,
}

fn aabb(b: &DetBox) -> Aabb {
    let mut x0 = i32::MAX;
    let mut y0 = i32::MAX;
    let mut x1 = i32::MIN;
    let mut y1 = i32::MIN;
    for p in &b.quad {
        let x = p[0].round() as i32;
        let y = p[1].round() as i32;
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    Aabb { x0, y0, x1, y1 }
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let n = v.len();
    if n == 0 {
        0.0
    } else if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

fn center_x(b: &Aabb) -> f32 {
    (b.x0 + b.x1) as f32 / 2.0
}

/// 阅读顺序分组：栏（先左后右）→ 行（上到下）→ 框（左到右），不拍扁。
/// 调用方按行取文本拼接、行间换行；`idxs` 指向输入 `boxes`，几何仍在原框上。
pub fn sort_reading(boxes: &[DetBox]) -> Vec<ReadingColumn> {
    if boxes.is_empty() {
        return Vec::new();
    }
    let ab: Vec<Aabb> = boxes.iter().map(aabb).collect();
    let mut order: Vec<usize> = (0..boxes.len()).collect();
    order.sort_by_key(|&i| (ab[i].y0, ab[i].x0));

    let mut rows: Vec<Row> = Vec::new();
    for &i in &order {
        let mut best: Option<(usize, f32)> = None;
        for (ri, row) in rows.iter().enumerate() {
            let ov = (row.y1.min(ab[i].y1) - row.y0.max(ab[i].y0)) as f32;
            if ov <= 0.0 {
                continue;
            }
            let h_box = (ab[i].y1 - ab[i].y0) as f32;
            let h_line = median(
                row.idxs
                    .iter()
                    .map(|&j| (ab[j].y1 - ab[j].y0) as f32)
                    .collect(),
            );
            let ratio = ov / h_box.min(h_line).max(1.0);
            if ratio < ROW_OVERLAP_MIN {
                continue;
            }
            let better = match best {
                Some((_, bo)) => ov > bo,
                None => true,
            };
            if better {
                best = Some((ri, ov));
            }
        }
        match best {
            Some((ri, _)) => {
                rows[ri].idxs.push(i);
                rows[ri].y0 = rows[ri].y0.min(ab[i].y0);
                rows[ri].y1 = rows[ri].y1.max(ab[i].y1);
            }
            None => rows.push(Row {
                idxs: vec![i],
                y0: ab[i].y0,
                y1: ab[i].y1,
            }),
        }
    }

    for row in &mut rows {
        row.idxs.sort_by_key(|&i| (ab[i].x0, ab[i].y0));
    }
    rows.sort_by(|a, b| {
        let ya = median(
            a.idxs
                .iter()
                .map(|&i| (ab[i].y0 + ab[i].y1) as f32 / 2.0)
                .collect(),
        );
        let yb = median(
            b.idxs
                .iter()
                .map(|&i| (ab[i].y0 + ab[i].y1) as f32 / 2.0)
                .collect(),
        );
        ya.partial_cmp(&yb).unwrap_or(Ordering::Equal)
    });

    let mut buckets: BTreeMap<i32, (Vec<usize>, f32, usize)> = BTreeMap::new();
    for (ri, row) in rows.iter().enumerate() {
        if row.idxs.len() < 2 {
            continue;
        }
        let mut gaps: Vec<(f32, f32)> = Vec::new();
        let mut positives: Vec<f32> = Vec::new();
        for pair in row.idxs.windows(2) {
            let (a, b) = (ab[pair[0]], ab[pair[1]]);
            let gap = (b.x0 - a.x1) as f32;
            if gap > 0.0 {
                positives.push(gap);
                gaps.push((gap, (a.x1 + b.x0) as f32 / 2.0));
            }
        }
        if positives.is_empty() {
            continue;
        }
        let med = median(positives);
        let solo = gaps.len() == 1;
        for (gap, center) in gaps {
            if gap < GAP_MIN_PX {
                continue;
            }
            if !solo && gap <= GAP_MED_RATIO * med {
                continue;
            }
            let bucket = (center / BUCKET_W).floor() as i32;
            let entry = buckets.entry(bucket).or_insert((Vec::new(), 0.0, 0));
            if !entry.0.contains(&ri) {
                entry.0.push(ri);
            }
            entry.1 += center;
            entry.2 += 1;
        }
    }

    let mut gutter: Option<f32> = None;
    let mut best_rows = 0usize;
    let mut best_bucket = i32::MAX;
    for (&bucket, (row_ids, sum, count)) in &buckets {
        if row_ids.len() < GUTTER_ROWS_MIN {
            continue;
        }
        let better =
            row_ids.len() > best_rows || (row_ids.len() == best_rows && bucket < best_bucket);
        if better {
            best_rows = row_ids.len();
            best_bucket = bucket;
            gutter = Some(*sum / *count as f32);
        }
    }

    match gutter {
        Some(split) => {
            let mut left: Vec<ReadingRow> = Vec::new();
            let mut right: Vec<ReadingRow> = Vec::new();
            for row in &rows {
                let mut l = Vec::new();
                let mut r = Vec::new();
                for &i in &row.idxs {
                    if center_x(&ab[i]) < split {
                        l.push(i);
                    } else {
                        r.push(i);
                    }
                }
                if !l.is_empty() {
                    left.push(ReadingRow { idxs: l });
                }
                if !r.is_empty() {
                    right.push(ReadingRow { idxs: r });
                }
            }
            let mut columns = Vec::new();
            if !left.is_empty() {
                columns.push(ReadingColumn { rows: left });
            }
            if !right.is_empty() {
                columns.push(ReadingColumn { rows: right });
            }
            columns
        }
        None => vec![ReadingColumn {
            rows: rows
                .into_iter()
                .map(|row| ReadingRow { idxs: row.idxs })
                .collect(),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// 按阅读顺序拍扁成 boxes 下标。
    fn flat(cols: &[ReadingColumn]) -> Vec<usize> {
        cols.iter()
            .flat_map(|c| c.rows.iter().flat_map(|r| r.idxs.iter().copied()))
            .collect()
    }

    fn sorted_xs(boxes: &[DetBox]) -> Vec<i32> {
        let cols = sort_reading(boxes);
        flat(&cols)
            .iter()
            .map(|&i| boxes[i].quad[0][0].round() as i32)
            .collect()
    }

    #[test]
    fn scrambled_same_row_sorts_left_to_right() {
        let boxes = vec![
            bx(400, 0, 440, 20),
            bx(0, 1, 40, 21),
            bx(200, 2, 240, 22),
            bx(100, 1, 140, 21),
            bx(300, 0, 340, 20),
        ];
        let cols = sort_reading(&boxes);
        assert_eq!(cols.len(), 1);
        assert_eq!(cols[0].rows.len(), 1);
        assert_eq!(sorted_xs(&boxes), vec![0, 100, 200, 300, 400]);
    }

    #[test]
    fn wide_gaps_in_same_row_stay_one_row() {
        let boxes = vec![
            bx(0, 0, 40, 20),
            bx(100, 0, 140, 20),
            bx(200, 0, 240, 20),
            bx(300, 0, 340, 20),
            bx(400, 0, 440, 20),
        ];
        let cols = sort_reading(&boxes);
        assert_eq!(cols.len(), 1);
        assert_eq!(cols[0].rows.len(), 1);
        assert_eq!(flat(&cols), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn uniform_wide_gaps_do_not_split() {
        let mut boxes = Vec::new();
        for row in 0..3i32 {
            for i in 0..5i32 {
                let x = i * 100;
                boxes.push(bx(x, row * 40, x + 40, row * 40 + 20));
            }
        }
        let cols = sort_reading(&boxes);
        assert_eq!(cols.len(), 1);
        assert_eq!(cols[0].rows.len(), 3);
        let expect: Vec<i32> = (0..3).flat_map(|_| (0..5).map(|i| i * 100)).collect();
        assert_eq!(sorted_xs(&boxes), expect);
    }

    #[test]
    fn two_column_gutter_reads_left_column_first() {
        let mut boxes = Vec::new();
        for row in 0..3i32 {
            boxes.push(bx(0, row * 40, 60, row * 40 + 20));
            boxes.push(bx(300, row * 40, 380, row * 40 + 20));
        }
        let cols = sort_reading(&boxes);
        assert_eq!(cols.len(), 2);
        assert!(cols.iter().all(|c| c.rows.len() == 3));
        assert_eq!(sorted_xs(&boxes), vec![0, 0, 0, 300, 300, 300]);
    }

    #[test]
    fn empty_and_single_pass_through() {
        assert!(sort_reading(&[]).is_empty());
        let boxes = vec![bx(10, 10, 50, 30)];
        let cols = sort_reading(&boxes);
        assert_eq!(cols.len(), 1);
        assert_eq!(flat(&cols), vec![0]);
    }
}
