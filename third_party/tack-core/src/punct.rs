//! 标点判定：段落聚段（tack-ocr）与选句（text_select）共用，避免两套口径漂移。
//! 偏移均按 UTF-16 code unit（与结果卡一致）。
//!
//! ASCII `.` 按序四判（见 `docs/OCR-CARD-PARAGRAPH-V3-2026-09-25.md` §8）：
//! 1. 两侧紧贴 ASCII 字母/数字 → token 内部（文件名 `text_select.rs` / `11.png`、
//!    域名 `github.com`、版本 `v1.2.3`、小数 `3.14`）；
//! 2. 1–2 位数字 + `.` 且数字前是段首/空白/句末/收尾符、点后非数字 → 列表标记（`1.如果`）；
//! 3. 缩写词表 / 首字母链 → 缩写点（`Mr.` `etc.` `U.S.` `J. K.`）；
//! 4. 其余 → 句末。
//!
//! 另有：ASCII `...` 整体按省略号消费；`!` / `?` 紧贴 token（`println!(` `?a=1`）不算句末。
//! `；` / `;` 不是句末（中文分号连接同一句的并列分句）。

/// 句末符（CJK / ASCII，含全半角变体）。
pub fn is_terminator(c: u16) -> bool {
    matches!(
        c,
        0x3002 // 。
            | 0xFF61 // ｡
            | 0xFF0E // ．
            | 0xFF01 // ！
            | 0xFF1F // ？
            | 0x2026 // …
            | 0x0021 // !
            | 0x003F // ?
            | 0x002E // .
    )
}

/// 收尾符：句末后可跟的引号/括号。
pub fn is_closer(c: u16) -> bool {
    matches!(
        c,
        0x300D // 」
            | 0x300F // 』
            | 0x300B // 》
            | 0x201D // ”
            | 0x2019 // ’
            | 0x0022 // "
            | 0x0027 // '
            | 0xFF09 // ）
            | 0x0029 // )
            | 0x005D // ]
            | 0xFF3D // ］
            | 0x3011 // 】
            | 0x3015 // 〕
            | 0xFF5D // ｝
            | 0x007D // }
    )
}

/// 空白（含全角空格与 Unicode 各类空格；OCR 可能吐 NBSP）。
pub fn is_space(c: u16) -> bool {
    matches!(
        c,
        0x0009 | 0x000A | 0x000D | 0x0020 | 0x00A0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029
            | 0x202F | 0x205F | 0x3000
    )
}

/// 汉字 / 假名 / 谚文以及 CJK 标点（拼接去重与译文分隔判定共用；与 OCR 侧同表）。
pub fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x1100..=0x11FF
            | 0x2E80..=0x2EFF
            | 0x3000..=0x303F
            | 0x3040..=0x30FF
            | 0x3130..=0x318F
            | 0x31C0..=0x31EF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA960..=0xA97F
            | 0xAC00..=0xD7AF
            | 0xF900..=0xFAFF
            | 0xFE30..=0xFE4F
            | 0xFF00..=0xFFEF
            | 0x20000..=0x2FA1F
    )
}

fn is_ascii_digit(c: u16) -> bool {
    (0x30..=0x39).contains(&c)
}

fn is_ascii_alpha(c: u16) -> bool {
    (0x41..=0x5A).contains(&c) || (0x61..=0x7A).contains(&c)
}

fn is_ascii_alnum(c: u16) -> bool {
    is_ascii_digit(c) || is_ascii_alpha(c)
}

/// 位置 `i` 的终止符长度：`……` 记 2、ASCII `...` 记 3、其余记 1；非终止符记 0。
pub fn terminator_len(seq: &[u16], i: usize) -> usize {
    let Some(&c) = seq.get(i) else {
        return 0;
    };
    if c == 0x2026 {
        return if seq.get(i + 1) == Some(&0x2026) { 2 } else { 1 };
    }
    if c == 0x002E && seq.get(i + 1) == Some(&0x002E) && seq.get(i + 2) == Some(&0x002E) {
        return 3;
    }
    if is_terminator(c) {
        1
    } else {
        0
    }
}

/// 位置 `i` 的终止符是否真的断句（token 内部 / 列表标记 / 缩写 / 宏 `!` 等不断）。
pub fn is_sentence_break_at(seq: &[u16], i: usize) -> bool {
    let Some(&c) = seq.get(i) else {
        return false;
    };
    if !is_terminator(c) {
        return false;
    }
    if c == 0x002E {
        return !dot_is_token_internal(seq, i)
            && !dot_is_list_marker(seq, i)
            && !dot_is_abbrev(seq, i);
    }
    if c == 0x0021 || c == 0x003F {
        return !bang_is_token_internal(seq, i);
    }
    true
}

/// 串尾是否为句末（视觉行尾判定）：跳过收尾空白与收尾符后判定。
pub fn ends_sentence(seq: &[u16]) -> bool {
    let mut end = seq.len();
    while end > 0 && is_space(seq[end - 1]) {
        end -= 1;
    }
    while end > 0 && is_closer(seq[end - 1]) {
        end -= 1;
    }
    if end == 0 {
        return false;
    }
    is_sentence_break_at(seq, end - 1)
}

/// 句内停顿符：逗号 / 顿号（行尾出现 → 句子必续，工整文本的段不以它收尾）。
/// 分号不收（列表项常以 `；` 收尾，见版式集 12 号语义）。
pub fn is_intra_punct(c: u16) -> bool {
    matches!(c, 0xFF0C | 0x002C | 0x3001)
}

/// 串尾（跳过空白与收尾符）是否为句内停顿符。
pub fn ends_with_intra_punct(seq: &[u16]) -> bool {
    let mut end = seq.len();
    while end > 0 && (is_space(seq[end - 1]) || is_closer(seq[end - 1])) {
        end -= 1;
    }
    end > 0 && is_intra_punct(seq[end - 1])
}

/// 串内是否出现句内标点（逗号 / 顿号）——折行段落的「散文标点痕迹」（v3.3 句中续接用）。
pub fn contains_intra_punct(seq: &[u16]) -> bool {
    seq.iter().any(|&c| is_intra_punct(c))
}

/// 串尾（跳过空白与收尾符）是否以停顿标点收尾（`，` `,` `、` `；` `;` `：` `:`）——
/// 这类行尾更像列表项 / 分句边界，句中折行续接（v3.3 `mid`）不适用，交几何判定。
pub fn ends_with_pause_punct(seq: &[u16]) -> bool {
    let mut end = seq.len();
    while end > 0 && (is_space(seq[end - 1]) || is_closer(seq[end - 1])) {
        end -= 1;
    }
    end > 0
        && (is_intra_punct(seq[end - 1])
            || matches!(seq[end - 1], 0xFF1B | 0x003B | 0xFF1A | 0x003A))
}

/// 配对符号族（半/全角同族，容忍 OCR 混用）：开符号 → 族号。
pub fn open_pair_family(c: u16) -> Option<u8> {
    Some(match c {
        0xFF08 | 0x0028 => 0,          // （ (
        0x3010 | 0x005B | 0xFF3B => 1, // 【 [ ［
        0x3014 => 2,                   // 〔
        0xFF5B | 0x007B => 3,          // ｛ {
        0x201C => 4,                   // “
        0x2018 => 5,                   // ‘
        0x300C => 6,                   // 「
        0x300E => 7,                   // 『
        _ => return None,
    })
}

/// 配对符号族：闭符号 → 族号。
pub fn close_pair_family(c: u16) -> Option<u8> {
    Some(match c {
        0xFF09 | 0x0029 => 0,          // ） )
        0x3011 | 0x005D | 0xFF3D => 1, // 】 ] ］
        0x3015 => 2,                   // 〕
        0xFF5D | 0x007D => 3,          // ｝ }
        0x201D => 4,                   // ”
        0x2019 => 5,                   // ’
        0x300D => 6,                   // 」
        0x300F => 7,                   // 』
        _ => return None,
    })
}

/// ASCII `"` 的伪族（同形开关配对）。
pub const QUOTE_FAMILY_DQ: u8 = 255;

fn apply_pair_char(c: u16, stack: &mut Vec<u8>, dq: &mut bool) {
    if c == 0x0022 {
        *dq = !*dq;
    } else if let Some(f) = open_pair_family(c) {
        stack.push(f);
    } else if let Some(f) = close_pair_family(c) {
        if let Some(pos) = stack.iter().rposition(|&e| e == f) {
            stack.remove(pos);
        }
    }
}

/// 串中未闭合的开符号族（栈序；ASCII `"` 以奇偶计）。
pub fn unclosed_pair_families(seq: &[u16]) -> Vec<u8> {
    let mut stack: Vec<u8> = Vec::new();
    let mut dq = false;
    for &c in seq {
        apply_pair_char(c, &mut stack, &mut dq);
    }
    if dq {
        stack.push(QUOTE_FAMILY_DQ);
    }
    stack
}

/// `seq` 是否含族 `f` 的闭符号（`QUOTE_FAMILY_DQ` = ASCII `"`）。
pub fn contains_pair_closer(seq: &[u16], f: u8) -> bool {
    if f == QUOTE_FAMILY_DQ {
        return seq.contains(&0x0022);
    }
    seq.iter().any(|&c| close_pair_family(c) == Some(f))
}

/// 断点是否落在未闭合配对内：`prev` 末仍有开符号，且 `next` 中的闭符号
/// **真正闭合了这些开符号**（而非只闭合 `next` 自身新开的配对）。
/// 半/全角同族；ASCII `"` 奇偶。用于聚段 v3.2 配对优先。
pub fn pair_crosses_break(prev: &[u16], next: &[u16]) -> bool {
    let mut stack: Vec<u8> = Vec::new();
    let mut dq = false;
    for &c in prev {
        apply_pair_char(c, &mut stack, &mut dq);
    }
    let baseline = stack.len() + usize::from(dq);
    if baseline == 0 {
        return false;
    }
    for &c in next {
        apply_pair_char(c, &mut stack, &mut dq);
        if stack.len() + usize::from(dq) < baseline {
            return true;
        }
    }
    false
}

/// `.` 是否为 token 内部：两侧紧贴 ASCII 字母/数字（`11.png`、`text_select.rs`、`3.14`）。
pub fn dot_is_token_internal(seq: &[u16], i: usize) -> bool {
    if seq.get(i) != Some(&0x002E) {
        return false;
    }
    let prev = i.checked_sub(1).and_then(|p| seq.get(p)).copied();
    let next = seq.get(i + 1).copied();
    matches!(prev, Some(p) if is_ascii_alnum(p)) && matches!(next, Some(n) if is_ascii_alnum(n))
}

/// 列表标记点：1–2 位数字 + `.`，数字前是段首/空白/句末/收尾符，点后非数字（`1.如果`）。
pub fn dot_is_list_marker(seq: &[u16], i: usize) -> bool {
    if seq.get(i) != Some(&0x002E) {
        return false;
    }
    if matches!(seq.get(i + 1), Some(n) if is_ascii_digit(*n)) {
        return false;
    }
    let mut j = i;
    let mut digits = 0usize;
    while digits < 2 && j > 0 && is_ascii_digit(seq[j - 1]) {
        j -= 1;
        digits += 1;
    }
    if digits == 0 {
        return false;
    }
    if j == 0 {
        return true;
    }
    let before = seq[j - 1];
    is_space(before) || is_terminator(before) || is_closer(before)
}

/// 缩写词表（小写、去内部点）：命中即「非句末」。宁缺毋滥：
/// `No.` / `am` / `pm` / `PhD` 等误伤大于收益的项不收（已知 miss）。
pub const ABBREV_WORDS: &[&str] = &[
    // 称谓
    "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "rev",
    // 拉丁 / 引用
    "eg", "ie", "etc", "vs", "cf", "al", "approx", "fig", "eq", "vol", "pp", "ch", "sec", "ed",
    "eds",
    // 机构 / 商业
    "inc", "ltd", "co", "corp", "dept", "univ", "bros",
    // 月份（5 月无缩写）
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// 位置 `i` 的 `.` 是否属于缩写/首字母（`Mr.` `etc.` `U.S.` `J. K.`）。
pub fn dot_is_abbrev(seq: &[u16], i: usize) -> bool {
    let mut start = i;
    while start > 0 && (is_ascii_alpha(seq[start - 1]) || seq[start - 1] == 0x002E) {
        start -= 1;
    }
    let word: String = seq[start..i]
        .iter()
        .filter_map(|&c| char::from_u32(c as u32))
        .collect();
    if word.is_empty() {
        return false;
    }
    let key: String = word
        .chars()
        .filter(|c| *c != '.')
        .flat_map(|c| c.to_lowercase())
        .collect();
    ABBREV_WORDS.contains(&key.as_str()) || initialism_groups(seq, i) >= 2
}

/// 从点 `i` 往前数连续「单字母 + `.`」组（允许组间空格）：
/// `U.S.`、`e.g.`、`J. K.` → ≥2；单个 `A.` → 1；`etc.` → 0。
pub fn initialism_groups(seq: &[u16], i: usize) -> usize {
    let mut cursor = i;
    let mut groups = 0usize;
    while groups < 2 {
        if seq.get(cursor) != Some(&0x002E) {
            break;
        }
        if cursor == 0 || !is_ascii_alpha(seq[cursor - 1]) {
            break;
        }
        if cursor >= 2 && is_ascii_alpha(seq[cursor - 2]) {
            break; // 前面还有字母 → 普通词尾（如 etc.），不是单字母组
        }
        cursor -= 1;
        groups += 1;
        if groups >= 2 {
            break;
        }
        let mut p = cursor;
        while p > 0 && seq[p - 1] == 0x0020 {
            p -= 1;
        }
        if p == 0 || seq[p - 1] != 0x002E {
            break;
        }
        cursor = p - 1;
    }
    groups
}

/// `!` / `?` 是否紧贴 token：前是字母/数字，且后是字母/数字或 `(` `[` `{`
/// （宏调用 `println!(`、集合 `vec![`、URL 参数 `?a=1`）。
pub fn bang_is_token_internal(seq: &[u16], i: usize) -> bool {
    let Some(&c) = seq.get(i) else {
        return false;
    };
    if c != 0x0021 && c != 0x003F {
        return false;
    }
    if i == 0 || !is_ascii_alnum(seq[i - 1]) {
        return false;
    }
    match seq.get(i + 1).copied() {
        Some(n) => is_ascii_alnum(n) || matches!(n, 0x0028 | 0x005B | 0x007B),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn end(s: &str) -> bool {
        ends_sentence(&u(s))
    }

    #[test]
    fn dot_token_internal_rules() {
        assert!(dot_is_token_internal(&u("11.png"), 2));
        assert!(dot_is_token_internal(&u("text_select.rs"), 11));
        assert!(dot_is_token_internal(&u("github.com"), 6));
        assert!(dot_is_token_internal(&u("v1.2.3"), 2));
        assert!(dot_is_token_internal(&u("3.14"), 1));
        assert!(!dot_is_token_internal(&u("结束.下一句"), 2));
    }

    #[test]
    fn dot_list_marker_rules() {
        assert!(dot_is_list_marker(&u("1.如果"), 1));
        assert!(dot_is_list_marker(&u("2. 第二项"), 1));
        assert!(dot_is_list_marker(&u("甲。2.乙"), 3));
        assert!(!dot_is_list_marker(&u("第1.名"), 2));
        assert!(!dot_is_list_marker(&u("1.5 倍的量"), 1));
        assert!(!dot_is_list_marker(&u("2026. 年"), 4));
    }

    #[test]
    fn dot_abbrev_rules() {
        assert!(dot_is_abbrev(&u("Mr."), 2));
        assert!(dot_is_abbrev(&u("等等 etc."), 7));
        assert!(dot_is_abbrev(&u("见 U.S."), 5));
        assert!(dot_is_abbrev(&u("J. K."), 4));
        assert!(!dot_is_abbrev(&u("答案是 A."), 5));
    }

    #[test]
    fn bang_token_internal_rules() {
        assert!(bang_is_token_internal(&u("println!(\"x\")"), 7));
        assert!(bang_is_token_internal(&u("vec![1]"), 3));
        assert!(bang_is_token_internal(&u("github.com?a=1"), 10));
        assert!(!bang_is_token_internal(&u("结束!"), 2));
        assert!(!bang_is_token_internal(&u("结束! 下句"), 2));
    }

    #[test]
    fn intra_punct_rules() {
        assert!(ends_with_intra_punct(&u("第一项、")));
        assert!(ends_with_intra_punct(&u("hello,")));
        assert!(ends_with_intra_punct(&u("（见附录，）")));
        assert!(!ends_with_intra_punct(&u("结束。")));
        assert!(!ends_with_intra_punct(&u("Cargo.lock）")));
        assert!(!ends_with_intra_punct(&u("未完；")));
    }

    #[test]
    fn mid_wrap_punct_helpers() {
        assert!(contains_intra_punct(&u("teams, namely")));
        assert!(contains_intra_punct(&u("甲、乙")));
        assert!(!contains_intra_punct(&u("no punctuation here")));
        assert!(ends_with_pause_punct(&u("甲；")));
        assert!(ends_with_pause_punct(&u("如下：")));
        assert!(ends_with_pause_punct(&u("未完，")));
        assert!(ends_with_pause_punct(&u("tiring,\"")));
        assert!(!ends_with_pause_punct(&u("economic and")));
        assert!(!ends_with_pause_punct(&u("结束。")));
    }

    #[test]
    fn pair_family_rules() {
        // 半/全角同族：混用也能闭合。
        let mixed = u("（abc)");
        assert_eq!(unclosed_pair_families(&mixed), Vec::<u8>::new());
        let open = u("提交（tack-ocr、Cargo.lock");
        assert_eq!(unclosed_pair_families(&open), vec![0]);
        assert!(contains_pair_closer(&u("Cargo.lock）"), 0));
        assert!(contains_pair_closer(&u("Cargo.lock)"), 0));
        assert!(!contains_pair_closer(&u("Cargo.lock"), 0));
        // 引号族与 ASCII 双引号奇偶。
        assert_eq!(unclosed_pair_families(&u("他说“你好")), vec![4]);
        assert_eq!(unclosed_pair_families(&u("He said \"Stop")), vec![QUOTE_FAMILY_DQ]);
        assert_eq!(unclosed_pair_families(&u("He said \"Stop\"")), Vec::<u8>::new());
        // 无开符号的孤立闭符号不算未闭合。
        assert_eq!(unclosed_pair_families(&u("Cargo.lock）")), Vec::<u8>::new());
    }

    #[test]
    fn pair_crosses_break_rules() {
        // 真跨折行闭合。
        assert!(pair_crosses_break(
            &u("提交（tack-ocr v3 聚段"),
            &u("Cargo.lock）")
        ));
        assert!(pair_crosses_break(&u("提交（tack-ocr"), &u("Cargo.lock)"))); // 半/全角
        assert!(pair_crosses_break(&u("他说“你好"), &u("世界”")));
        assert!(pair_crosses_break(&u("He said \"Stop"), &u("now.\"")));
        // next 自身成对的同族闭符号，不得误判为闭合 prev。
        assert!(!pair_crosses_break(
            &u("详见说明（未完"),
            &u("另一段（已完）开头")
        ));
        assert!(!pair_crosses_break(&u("see ("), &u("(foo) bar")));
        // prev 无未闭合 / next 无可用闭符号。
        assert!(!pair_crosses_break(&u("普通行"), &u("Cargo.lock）")));
        assert!(!pair_crosses_break(&u("提交（未完"), &u("仍未闭合")));
    }

    #[test]
    fn terminator_len_rules() {
        assert_eq!(terminator_len(&u("等等...然后"), 2), 3);
        assert_eq!(terminator_len(&u("等等……然后"), 2), 2);
        assert_eq!(terminator_len(&u("句。"), 1), 1);
        assert_eq!(terminator_len(&u("未完"), 1), 0);
    }

    #[test]
    fn ends_sentence_rules() {
        assert!(end("话说完。"));
        assert!(end("结束! "));
        assert!(end("结束？"));
        assert!(end("他说「走。」"));
        assert!(end("等等……"));
        assert!(end("答案是第1.")); // v3：数字前非句界 → 是句末
        assert!(!end("还没说完"));
        assert!(!end("值为3.14"));
        assert!(!end("未完（"));
        assert!(!end("甲分句；"));
        assert!(!end("未完，"));
        assert!(!end("Mr."));
        assert!(!end("等等 etc."));
        assert!(!end("见 U.S."));
        assert!(!end("J. K."));
        assert!(!end("1."));
        // 行尾 Unicode 空白（NBSP）不影响句末判定。
        assert!(end("结束。\u{A0}"));
        // v3.2 配对闭符号也是收尾符（否则「结束。】」会被判非句末）。
        assert!(end("结束。】"));
        assert!(end("结束。〕"));
        assert!(end("结束。}"));
        assert!(ends_with_intra_punct(&u("附录，】")));
    }
}
