use rten_tensor::prelude::*;
use rten_tensor::NdTensor;

pub const SCORE_THRESH: f32 = 0.4;

/// 单框识别输出：文本 + 置信分 + 每次发射（token）的中心时间步比例（0..1，沿阅读轴）。
/// `centers` 与 `text` 的 token 顺序一一对应；token 含多个 UTF-16 单元时由调用方展开。
pub struct RecOut {
    pub text: String,
    pub score: f32,
    pub centers: Vec<f32>,
}

pub fn ctc_decode(logits: &NdTensor<f32, 3>, alphabet: &[String]) -> RecOut {
    let t_len = logits.shape()[1];
    let c_len = logits.shape()[2];
    // 逐时间步 argmax，再按 run 折叠（CTC 去重），顺带记录每个发射的时间步区间。
    let mut bests = Vec::with_capacity(t_len);
    for ti in 0..t_len {
        let mut best = 0usize;
        let mut best_v = f32::MIN;
        for ci in 0..c_len {
            let v = logits[[0, ti, ci]];
            if v > best_v {
                best_v = v;
                best = ci;
            }
        }
        bests.push(best);
    }
    let mut text = String::new();
    let mut centers = Vec::new();
    let mut score_sum = 0.0f32;
    let mut kept = 0usize;
    let mut i = 0usize;
    while i < t_len {
        let cls = bests[i];
        let mut j = i + 1;
        while j < t_len && bests[j] == cls {
            j += 1;
        }
        if cls != 0 && cls < alphabet.len() {
            text.push_str(&alphabet[cls]);
            let best_v = logits[[0, i, cls]];
            let row_sum: f64 = (0..c_len).map(|ci| logits[[0, i, ci]] as f64).sum();
            let prob = if (row_sum - 1.0).abs() < 1e-2 {
                best_v
            } else {
                let mut sum = 0.0f64;
                for ci in 0..c_len {
                    sum += ((logits[[0, i, ci]] - best_v) as f64).exp();
                }
                (1.0 / sum) as f32
            };
            score_sum += prob;
            kept += 1;
            centers.push((i as f32 + j as f32) * 0.5 / t_len.max(1) as f32);
        }
        i = j;
    }
    RecOut {
        text,
        score: if kept > 0 {
            score_sum / kept as f32
        } else {
            0.0
        },
        centers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rten_tensor::NdTensor;

    /// 用 one-hot 行构造 logits：`steps[ti] = (类别, 概率)`。
    fn logits_of(c_len: usize, steps: &[(usize, f32)]) -> NdTensor<f32, 3> {
        let t_len = steps.len();
        let mut data = vec![0.0f32; t_len * c_len];
        for (ti, &(cls, prob)) in steps.iter().enumerate() {
            data[ti * c_len + cls] = prob;
            for ci in 0..c_len {
                if ci != cls {
                    data[ti * c_len + ci] = (1.0 - prob).max(0.0) / (c_len - 1).max(1) as f32;
                }
            }
        }
        NdTensor::from_data([1, t_len, c_len], data)
    }

    #[test]
    fn empty_logits_yield_empty() {
        let logits = NdTensor::<f32, 3>::zeros([1, 0, 4]);
        let alphabet = vec![
            String::new(),
            "a".into(),
            "b".into(),
            " ".into(),
        ];
        let out = ctc_decode(&logits, &alphabet);
        assert!(out.text.is_empty());
        assert_eq!(out.score, 0.0);
        assert!(out.centers.is_empty());
    }

    #[test]
    fn centers_track_run_midpoints() {
        let alphabet = vec![
            String::new(),
            "a".into(),
            "b".into(),
            " ".into(),
        ];
        // a a _ b b b _ (空格) （共 8 步）：a=[0,2) b=[3,6) 空格=[7,8)
        let logits = logits_of(
            4,
            &[
                (1, 0.9),
                (1, 0.9),
                (0, 0.9),
                (2, 0.9),
                (2, 0.9),
                (2, 0.9),
                (0, 0.9),
                (3, 0.9),
            ],
        );
        let out = ctc_decode(&logits, &alphabet);
        assert_eq!(out.text, "ab ");
        assert_eq!(out.centers.len(), 3);
        assert!((out.centers[0] - 0.125).abs() < 1e-6);
        assert!((out.centers[1] - 0.5625).abs() < 1e-6);
        assert!((out.centers[2] - 0.9375).abs() < 1e-6);
        assert!(out.centers.windows(2).all(|w| w[0] < w[1]));
    }
}
