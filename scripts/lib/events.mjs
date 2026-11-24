/**
 * 击杀事件重建 —— scripts/lib/events.ps1 的 JS 版（逐函数一对一移植）。
 *
 * killfeed 是一个队列：新击杀追加到下方，旧条目过期后整体上移，一行停留 4-5s。
 * 所以「按文本去重」是错的判定：贤者（奶妈）的复活、暮蝶的自我复活，会让同一个敌人
 * 在同一回合里被同一个人杀多次，文本完全一样（一回合理论上最多 7 杀）。
 *
 * 判定规则看「屏幕占位」：
 *   1. 对每条文本，把它的命中时间切成若干「连续出现的时段」，时段内部允许 ≤ MergeGap 的
 *      OCR 漏帧（实测单次停留内会出现 2.5s 空档）；
 *   2. 每个时段产出「该时段内同时在屏的最大条数」个事件 —— 同一时刻屏幕上有两格是同一条
 *      文本，就是实实在在的两次击杀；
 *   3. 单纯的整体上移不会改变条目数，因此不会被重复计。
 *
 * 这样：跨回合重名 / 复活后再杀（时段间隔大）→ 多次；同屏两条同名 → 两次；
 *       OCR 漏帧（时段内空档）→ 仍算一次。
 *
 * 语义对齐（§11.3）：.NET 的 `\p{IsCJKUnifiedIdeographs}` 就是 U+4E00–9FFF 这个块，
 * 所以这里用 /[\u4E00-\u9FFF]/ 而不是更宽的 \p{Unified_Ideograph}（后者含扩展区、
 * 会把部首/兼容汉字也当汉字留下）。字符串下标两边都是 UTF-16 code unit。
 */

import { psRound } from './round.mjs'

// 与 PowerShell 的 `[\s\p{P}]` 等价：Unicode 空白 + 标点
const NOISE = /[\s\p{P}]/gu
const LEADING_NON_CJK = /^[^\u4E00-\u9FFF]+/u
const CJK_START = /^[\u4E00-\u9FFF]/
const ASCII_BETWEEN_CJK = /(?<=[\u4E00-\u9FFF])[0-9A-Za-z](?=[\u4E00-\u9FFF])/gu

/** 行首金框的判定阈值（%）：与推断本机 ID 用的是同一个值。 */
export const SELF_MARKER_MIN = 3.0
/**
 * 逐行否决的阈值（%）。故意压到很低，只用来区分「有没有金框」：
 * 本素材 39 个真击杀行的最低值是淡入瞬间的 0.232，敌方行恒为 0.000，
 * 所以 0.1 既能挡住敌方行，又不会把淡入那一帧真击杀丢掉。
 */
export const SELF_MARKER_VETO = 0.1

/**
 * 判断一条 killfeed 文本是不是「本地玩家的击杀」，并返回可用于分组的归一化文本。
 *
 * killfeed 一行是「杀手名 + 被杀者名」连写，所以必须做前缀匹配：用包含匹配会把
 * 「敌人把我杀了」（<敌人名><我的ID>）也算成本地玩家的击杀（文档 §6 坑 2）。
 *
 * 但纯前缀匹配又会漏，实测两种 OCR 偏差：
 *   1. 开头的武器/头像图标被读成字母：`IV 比奇堡恶霸鱼 being`、`G 比奇堡恶霸鱼 ...`
 *   2. 首字漏识别：`奇堡恶霸鱼搞事早把爱玩机瞄`（本应是 `比奇堡恶霸鱼…`）
 * 因此先剥掉开头的非汉字噪声，再允许「本地 ID 去掉首字」作为前缀；命中后把漏掉的首字补回去，
 * 让两种写法归一到同一个分组键，避免同一条击杀被当成两条。
 *
 * @param {string} text
 * @param {string} localId
 * @returns {string|null} 归一化文本；不是本机击杀时返回 null
 */
export function normalizeKillText (text, localId) {
  const id = String(localId ?? '').replace(NOISE, '')
  if (!id) return null

  let key = String(text ?? '').replace(NOISE, '')
  if (CJK_START.test(id)) {
    // 只对中文 ID 剥前缀噪声；英文 ID 的正文本身就是字母，剥完就空了
    key = key.replace(LEADING_NON_CJK, '')
  }
  if (!key) return null

  // 夹在两个汉字之间的单个字母/数字是 OCR 噪声（武器图标、准星读数等）：
  // 实测 `乐邦詹士贤者` 会被读成 `乐邦詹士9贤者`，不归一会同一行变成两个文本、
  // 从而被当成两次击杀。英文受害者名（如 `Mete0r4`）不受影响，因为那里的字母两侧不是汉字。
  key = key.replace(ASCII_BETWEEN_CJK, '')
  if (!key) return null

  // 不变量：归一化后必须还剩下受害者。真击杀 = 本机 ID + 受害者，剥完至少还剩 1 个字符；
  // 剩下的正好只有本机 ID 时，本机是「被击杀方」——例如 `ToneAim 乐邦詹士`：
  // ToneAim 是敌方拉丁 ID，被上面那条「剥开头非汉字噪声」整段吃掉，剩 `乐邦詹士`，
  // 于是前缀匹配成立、受害者却是空的（BUGS #1）。这里直接判为不是本机的击杀。
  if (key.startsWith(id)) {
    if (key.length <= id.length) return null
    return key
  }

  if (id.length >= 3 && key.startsWith(id.slice(1))) {
    const restored = id.slice(0, 1) + key
    // 同理：补回首字后仍等于本机 ID，说明受害者段整个丢了（`邦詹士` → `乐邦詹士`）
    if (restored.length <= id.length) return null
    return restored
  }
  return null
}

/**
 * 「行首金框」这个信号在本素材里是否可用。
 *
 * 金框只出现在「本机在杀手位」的行上（敌方红框、队友青框都不命中这套颜色判据），
 * 但 ROI 没框住头像框、或 kfocr 是不支持 `--marker` 的旧构建时，所有分数都是 0——
 * 这时如果照着 0 去否决，会把整条素材的击杀全砍掉。所以先看有没有任何一行的分数
 * 过 `minScore`，没有就退回纯文本判定（并告警），别静默把成片剪空。
 *
 * @param {number[]} scores  行首淡黄占比（0-100），可以含 undefined/NaN
 * @param {{minScore?:number,minSamples?:number}} [options]
 */
export function markerChannelUsable (scores, { minScore = SELF_MARKER_MIN, minSamples = 1 } = {}) {
  let seen = 0
  for (const s of scores ?? []) {
    if (Number.isFinite(s) && s >= minScore) seen++
    if (seen >= minSamples) return true
  }
  return false
}

/**
 * 用行首金框逐行否决「本机击杀」候选（BUGS #1 的治本那一条）。
 *
 * 文本只能证明「本机 ID 出现在这一行的开头」，证明不了它就在杀手位：本机 ID 是别人名字的
 * 前缀、或敌方拉丁 ID 被当成图标噪声剥掉，都会让「敌人杀我」看起来像「我杀人」。
 * 金框是屏幕上的直接证据，所以这里按行再筛一遍；被否掉的原始行一并返回，方便打日志核对。
 *
 * @param {Array<{t:number,text:string,marker?:number}>} hits
 * @param {{minMarker?:number}} [options]
 * @returns {{kept:Array, dropped:Array}}
 */
export function dropUnmarkedHits (hits, { minMarker = SELF_MARKER_VETO } = {}) {
  const kept = []
  const dropped = []
  for (const h of hits ?? []) {
    if ((h.marker ?? 0) >= minMarker) kept.push(h)
    else dropped.push(h)
  }
  return { kept, dropped }
}

/**
 * Levenshtein 编辑距离，用于识别同一击杀的 OCR 变体。
 * @param {string} a
 * @param {string} b
 */
export function textDistance (a, b) {
  const n = a.length
  const m = b.length
  if (n === 0) return m
  if (m === 0) return n
  let prev = new Array(m + 1)
  let cur = new Array(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j
  for (let i = 1; i <= n; i++) {
    cur[0] = i
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    const tmp = prev; prev = cur; cur = tmp
  }
  return prev[m]
}

/**
 * 合并「同一次击杀的不同 OCR 写法」。
 *
 * 武器/头像图标会被 OCR 成字母混进名字里（实测 `比奇堡恶霸鱼 being` 与
 * `比奇堡恶霸鱼 G being` 是同一条击杀），不合并就会把一次击杀算成两次。
 * 只合并「文本不同、时间相近、编辑距离很小」的事件；文本完全相同的不动，
 * 那是同屏两条真实击杀，由 killEvents 的占位计数负责。
 *
 * @param {Array<{t:number,text:string}>} events
 * @param {{maxGap?:number,maxDistance?:number}} [options]
 */
export function mergeVariantEvents (events, { maxGap = 1.5, maxDistance = 1 } = {}) {
  const kept = []
  for (const e of [...events].sort((x, y) => x.t - y.t)) {
    const dup = kept.some(k =>
      k.text !== e.text &&
      Math.abs(k.t - e.t) <= maxGap &&
      textDistance(k.text, e.text) <= maxDistance
    )
    if (!dup) kept.push(e)
  }
  return kept.sort((x, y) => x.t - y.t)
}

/** 最长公共前缀（按 UTF-16 code unit，与 PS 的字符串下标一致）。 */
export function commonPrefix (strings) {
  if (!strings || strings.length === 0) return ''
  let p = strings[0]
  for (const s of strings) {
    let i = 0
    while (i < p.length && i < s.length && p[i] === s[i]) i++
    p = p.slice(0, i)
    if (!p) break
  }
  return p
}

function normalizeIdCandidate (text) {
  return String(text ?? '').replace(NOISE, '').replace(LEADING_NON_CJK, '')
}

/**
 * 从「行首带黄框」的文本里推断本机 ID。纯函数，便于测试。
 *
 * 不用「全体候选的公共前缀」：只要混进一条误检（个别素材里会有黄值很高的非本机行），
 * 公共前缀就会被拉短到 1 个字符。改为「取支持度最高的公共前缀」——两两取最长公共前缀，
 * 再用它去统计有多少候选支持，离群点自然被稀释掉。
 *
 * @param {string[]} texts
 * @param {{minSamples?:number}} [options]
 * @returns {string|null}
 */
export function localIdFromTexts (texts, { minSamples = 2 } = {}) {
  const distinct = [...new Set((texts ?? []).map(normalizeIdCandidate).filter(Boolean))]
  if (distinct.length < minSamples) return null

  let best = null
  let bestSupport = 0
  for (const a of distinct) {
    for (const b of distinct) {
      if (a === b) continue
      const p = commonPrefix([a, b])
      if (p.length < 2) continue
      const support = distinct.filter(s => s.startsWith(p)).length
      // 前缀不能等于「支持它的某条文本」：那说明这段公共部分把受害者也吃进去了。
      // 注意只能看支持者，无关的等长离群点不该否决（例如前缀 4 字，另有 4 字的误检行）。
      if (distinct.some(s => s.startsWith(p) && s.length === p.length)) continue
      if (support > bestSupport || (support === bestSupport && p.length > (best ? best.length : 0))) {
        best = p
        bestSupport = support
      }
    }
  }
  if (!best) return null
  if (bestSupport < minSamples) return null
  return best
}

/**
 * 收集「行首黄框」的行，再推断本机 ID；样本不足或前缀不可信时返回 null。
 *
 * @param {Array<{text:string,path:string}>} rows
 * @param {(path:string)=>number} markerOf  行首淡黄占比（0-100）
 * @param {{minScore?:number,minSamples?:number}} [options]
 */
export function autoLocalId (rows, markerOf, { minScore = 3.0, minSamples = 2 } = {}) {
  const texts = []
  for (const r of rows ?? []) {
    if (!r.text || !r.path) continue
    if (markerOf(r.path) < minScore) continue
    texts.push(r.text)
  }
  return localIdFromTexts(texts, { minSamples })
}

/**
 * 由击杀事件生成切片区间。
 *
 * 前摇 Pre / 后摇 Post，间隔小于 MergeGap 的连续击杀并成一段交战。
 * 关键约束：段与段之间不允许重叠——两次击杀相隔 4.5–5.0s 时，后者前摇会早于前者后摇，
 * 不钳制就会把同一帧剪进两个切片、成片里同一段画面出现两次（实测 2025.09.21 素材：
 * 113.0 与 117.5 两次击杀，后摇到 114.5、前摇从 114.0 开始，重叠 0.5s）。
 *
 * @param {Array<{t:number,text:string}>} events
 * @param {{pre?:number,post?:number,mergeGap?:number,maxDuration?:number,minStart?:number}} [options]
 */
export function highlightSegments (events, {
  pre = 3.5,
  post = 1.5,
  mergeGap = 4.5,
  maxDuration = 12.0,
  minStart = 0
} = {}) {
  const segs = []
  for (const e of [...events].sort((x, y) => x.t - y.t)) {
    if (e.t < pre + 1) continue // 录像开头没有足够前摇，剪不出完整一段
    const last = segs[segs.length - 1]
    if (last && (e.t - last.lastT) < mergeGap) {
      last.end = Math.min(e.t + post, last.start + maxDuration)
      last.lastT = e.t
      last.text += ` + ${e.text}`
      continue
    }
    segs.push({
      start: Math.max(minStart, e.t - pre),
      end: e.t + post,
      lastT: e.t,
      text: e.text
    })
  }
  // maxDuration 只用来抑制「一路并下去」的无限增长，不能把最后一杀的后摇也吃掉
  for (const sg of segs) {
    if (sg.end < sg.lastT + post) sg.end = sg.lastT + post
  }
  // 钳掉段间重叠（后一段的起点是硬边界，优先于上一段的延长）
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].end - segs[i + 1].start > 1e-9) segs[i].end = segs[i + 1].start
  }
  return segs
}

/**
 * 把 OCR 命中（每帧每条击杀栏的文本）重建成击杀事件。
 *
 * @param {Array<{t:number,slot:number,text:string,score:number}>} hits
 * @param {{mergeGap?:number,maxAppearance?:number}} [options]
 */
export function killEvents (hits, { mergeGap = 3.0, maxAppearance = 6.0 } = {}) {
  const events = []
  if (!hits || hits.length === 0) return events

  /** @type {Map<string, Array<{t:number,slot:number,text:string,score:number}>>} */
  const groups = new Map()
  for (const h of hits) {
    if (!groups.has(h.text)) groups.set(h.text, [])
    groups.get(h.text).push(h)
  }

  for (const [text, group] of groups) {
    const perFrame = new Map() // t -> 该帧同时在屏的条数
    const slotAt = new Map() // t -> 槽位
    const scoreAt = new Map() // t -> 最高分

    for (const h of group) {
      perFrame.set(h.t, (perFrame.get(h.t) ?? 0) + 1)
      if (!slotAt.has(h.t)) slotAt.set(h.t, h.slot)
      scoreAt.set(h.t, Math.max(scoreAt.get(h.t) ?? 0.0, h.score))
    }

    const times = [...perFrame.keys()].sort((a, b) => a - b)
    let start = times[0]
    let maxCount = perFrame.get(times[0])
    let prev = times[0]

    for (let i = 1; i <= times.length; i++) {
      const t = i < times.length ? times[i] : null
      // 三种情况都要断开：
      //   间隔过大（跨回合 / 复活后再杀 / 屏幕清空）→ 新的一次出现；
      //   单次出现持续超过 maxAppearance → 一行不可能停留这么久，必然是两次出现首尾相接
      //   （例如第一行过期后 1.5s 又出现同样一行：间隔只有 1.5s，但总时长 9s）。
      const close = t === null || (t - prev) > mergeGap || (t - start) > maxAppearance

      if (close) {
        for (let k = 0; k < maxCount; k++) {
          events.push({
            t: psRound(start, 2),
            slot: slotAt.get(start),
            text,
            score: scoreAt.get(start)
          })
        }
        if (t !== null) {
          start = t
          maxCount = perFrame.get(t)
        }
      } else if (perFrame.get(t) > maxCount) {
        maxCount = perFrame.get(t)
      }
      if (t !== null) prev = t
    }
  }

  return events.sort((a, b) => a.t - b.t)
}
