/**
 * scripts/test-events.mjs —— scripts/test-events.ps1 的 JS 版，用例一一对应。
 *
 * 现有素材里没有出现「复活后再杀」，所以必须用构造数据验证判定规则。
 * 迁移期两个引擎各跑一遍，输出应逐行一致（都全 PASS）。
 *
 * 用法：node scripts/test-events.mjs
 */
import {
  killEvents,
  mergeVariantEvents,
  normalizeKillText,
  localIdFromTexts,
  dropUnmarkedHits,
  markerChannelUsable,
  highlightSegments
} from './lib/events.mjs'
import { roiFor } from './lib/roi.mjs'
import { psRound } from './lib/round.mjs'

const hit = (t, slot, text, score = 1.0) => ({ t: Number(t), slot, text, score: Number(score) })

// 生成一行在 [from, to] 内的命中（0.5s 步长，模拟 2fps）；twin 表示同时有两格显示同一条
function frames (text, from, to, slot = 0, { twin = false } = {}) {
  const rows = []
  for (let t = from; t <= to + 1e-9; t += 0.5) {
    rows.push(hit(t, slot, text))
    if (twin) rows.push(hit(t, slot + 1, text))
  }
  return rows
}

let failed = 0
function report (ok, label, expect, got) {
  if (!ok) failed++
  const tag = ok ? '[PASS]' : '[FAIL]'
  console.log(`${tag}  ${label.padEnd(34)} 期望 ${expect} 实得 ${got}`)
}

// ── killEvents：屏幕占位重建 ──────────────────────────────────────
const killCases = [
  { name: '单次击杀：一行停留 5s', hits: frames('A', 10, 14.5), expect: 1 },
  { name: 'OCR 漏帧 2.5s 空档：仍算一次', hits: [...frames('A', 7.5, 9), ...frames('A', 11.5, 12)], expect: 1 },
  { name: '跨回合重名：间隔 90s', hits: [...frames('A', 10, 14), ...frames('A', 104, 108)], expect: 2 },
  { name: '复活后再杀：首行过期 1.5s 后重现', hits: [...frames('A', 10, 14), ...frames('A', 15.5, 19.5)], expect: 2 },
  { name: '复活三连杀：三段各一次', hits: [...frames('A', 50, 54), ...frames('A', 58, 62), ...frames('A', 66, 70)], expect: 3 },
  { name: '同屏两条同名：slot0 与 slot1 各一条', hits: frames('A', 30, 34, 0, { twin: true }), expect: 2 },
  { name: '同屏两条 + 之后又一条：共三次', hits: [...frames('A', 30, 34, 0, { twin: true }), ...frames('A', 36, 40)], expect: 3 },
  { name: '两个不同受害者同一时刻', hits: [...frames('A', 40, 44, 0), ...frames('B', 40, 44, 1)], expect: 2 },
  { name: '上移不重复：条目数恒为 1', hits: frames('A', 80, 84), expect: 1 },
  { name: '无命中', hits: [], expect: 0 }
]
for (const c of killCases) {
  const got = killEvents(c.hits, { mergeGap: 3.0, maxAppearance: 6.0 })
  report(got.length === c.expect, c.name, c.expect, `${got.length}   t = ${got.map(e => e.t).join(',')}`)
}
console.log()

// ── normalizeKillText：前缀匹配 + OCR 容错 ─────────────────────────
const defId = '比奇堡恶霸鱼'
const matchCases = [
  { text: '比奇堡恶霸鱼艾斯卡诺', expect: '比奇堡恶霸鱼艾斯卡诺' },
  { text: '比奇堡恶霸鱼 being', expect: '比奇堡恶霸鱼being' },
  { text: 'IV 比奇堡恶霸鱼 being', expect: '比奇堡恶霸鱼being' },
  { text: 'G 比奇堡恶霸鱼原神转瓦偏运动', expect: '比奇堡恶霸鱼原神转瓦偏运动' },
  { text: '乐邦詹士9贤者', expect: '乐邦詹士贤者', id: '乐邦詹士' },
  { text: '奇堡恶霸鱼搞事早把爱玩机瞄', expect: '比奇堡恶霸鱼搞事早把爱玩机瞄' },
  { text: '乐邦詹士Mete0r4', expect: '乐邦詹士Mete0r4', id: '乐邦詹士' },
  { text: '原神转瓦偏运动比奇堡恶霸鱼', expect: null },
  { text: '总是泪萌萌艾斯卡诺', expect: null },
  // BUGS #1：本机在受害者位 —— 剥掉敌方拉丁 ID 后只剩本机 ID，必须判成「不是我的击杀」
  { text: 'ToneAim 乐邦詹士', expect: null, id: '乐邦詹士' },
  { text: 'ToneAim乐邦詹士', expect: null, id: '乐邦詹士' },
  { text: 'IV 乐邦詹士', expect: null, id: '乐邦詹士' },
  { text: 'G 乐邦詹士', expect: null, id: '乐邦詹士' },
  { text: '邦詹士', expect: null, id: '乐邦詹士' },
  { text: '乐邦詹士', expect: null, id: '乐邦詹士' }
]
for (const c of matchCases) {
  const got = normalizeKillText(c.text, c.id ?? defId)
  const ok = got === c.expect
  if (!ok) failed++
  console.log(`${ok ? '[PASS]' : '[FAIL]'}  ${c.text.padEnd(24)} → ${got === null ? '(不是本机击杀)' : got}`)
}
console.log()

// ── 行首金框：逐行否决（BUGS #1 治本 / TODO #1 撞名）────────────────
// 同一条文本，金框在行首才是本机的击杀；金框缺 → 敌方/队友在杀手位，一律否决。
const marked = (rows, marker) => rows.map(r => ({ ...r, marker }))
const markerCases = [
  { name: '金框在（3.8）→ 保留 1 次', hits: marked(frames('乐邦詹士香甜小蝶', 10, 12), 3.8), expect: 1 },
  { name: '敌方行（0.0）→ 否决', hits: marked(frames('乐邦詹士', 10, 12), 0.0), expect: 0 },
  { name: '淡入帧（0.232）→ 保留 1 次', hits: marked(frames('乐邦詹士香甜小蝶', 10, 12), 0.232), expect: 1 },
  { name: '缺 marker 字段 → 视作 0 → 否决', hits: frames('乐邦詹士香甜小蝶', 10, 12), expect: 0 },
  { name: '撞名：我杀同名人（3.8）→ 1 次', hits: marked(frames('乐邦詹士乐邦詹士', 10, 12), 3.8), expect: 1 },
  { name: '撞名：同名人杀我（0.0）→ 0 次', hits: marked(frames('乐邦詹士乐邦詹士', 10, 12), 0.0), expect: 0 },
  { name: '撞名：敌杀别人的名字以我开头（0.0）→ 0 次', hits: marked(frames('乐邦詹士香甜小蝶', 10, 12), 0.0), expect: 0 }
]
for (const c of markerCases) {
  const { kept, dropped } = dropUnmarkedHits(c.hits)
  const got = killEvents(kept, { mergeGap: 3.0, maxAppearance: 6.0 })
  report(got.length === c.expect, c.name, c.expect, `${got.length}（否决 ${dropped.length} 行）`)
}
const channelCases = [
  { name: '有行过 3.0 → 通道可用', scores: [0, 0.232, 3.7], expect: true },
  { name: '全 0（ROI 没框到金框）→ 不可用', scores: [0, 0, 0.232], expect: false },
  { name: '没有样本 → 不可用', scores: [], expect: false }
]
for (const c of channelCases) {
  const got = markerChannelUsable(c.scores)
  const ok = got === c.expect
  if (!ok) failed++
  console.log(`${ok ? '[PASS]' : '[FAIL]'}  ${c.name.padEnd(34)} 期望 ${c.expect} 实得 ${got}`)
}
console.log()

// ── mergeVariantEvents：同一次击杀的 OCR 变体 ─────────────────────
const variantCases = [
  {
    name: '同一击杀两种写法：差一个字母、相隔 0.5s',
    hits: [...frames('比奇堡恶霸鱼being', 103, 107), ...frames('比奇堡恶霸鱼Gbeing', 103.5, 104)],
    expect: 1
  },
  {
    name: '两个不同受害者同时出现（文本差异大）',
    hits: [...frames('比奇堡恶霸鱼艾斯卡诺', 40, 44), ...frames('比奇堡恶霸鱼搞事早把爱玩机瞄', 40.5, 44)],
    expect: 2
  },
  {
    name: '不同受害者名字相近（距离 2）不能误并',
    hits: [...frames('乐邦詹士雨滴小熊', 17, 21), ...frames('乐邦詹士心碎小熊', 17.5, 21)],
    expect: 2
  },
  {
    name: '同屏两条同名（文本相同）不受影响',
    hits: frames('比奇堡恶霸鱼being', 30, 34, 0, { twin: true }),
    expect: 2
  }
]
for (const c of variantCases) {
  const ev = mergeVariantEvents(killEvents(c.hits), { maxGap: 1.5 })
  report(ev.length === c.expect, c.name, c.expect, ev.length)
}
console.log()

// ── localIdFromTexts：从行首黄框的文本推断本机 ID ──────────────────
const idCases = [
  { name: '三种不同受害者 → 取公共前缀', texts: ['乐邦詹士Mete0r4', '乐邦詹士困了又困', '乐邦詹士心碎小熊'], expect: '乐邦詹士' },
  { name: '带图标噪声也归一后取前缀', texts: ['比奇堡恶霸鱼being', 'IV 比奇堡恶霸鱼艾斯卡诺', 'm 比奇堡恶霸鱼搞事早把爱玩机瞄'], expect: '比奇堡恶霸鱼' },
  { name: '只有一个样本 → 不可信', texts: ['乐邦詹士Mete0r4'], expect: null },
  { name: '两条完全相同 → 不可信', texts: ['乐邦詹士Mete0r4', '乐邦詹士Mete0r4'], expect: null },
  { name: '受害者同名导致前缀吃进受害者 → 拒绝', texts: ['乐邦詹士abc', '乐邦詹士abc'], expect: null },
  { name: '混入两条误检也不影响推断', texts: ['乐邦詹士Mete0r4', '乐邦詹士困了又困', '乐邦詹士雨滴小熊', '别的不相干', '金色传说'], expect: '乐邦詹士' }
]
for (const c of idCases) {
  const got = localIdFromTexts(c.texts)
  const ok = got === c.expect
  if (!ok) failed++
  console.log(`${ok ? '[PASS]' : '[FAIL]'}  ${c.name.padEnd(34)} 期望 ${c.expect ?? '(拒绝)'} 实得 ${got ?? '(拒绝)'}`)
}
console.log()

// ── highlightSegments：分段与前摇后摇 ─────────────────────────────
const ev = (t, text = 'x') => ({ t: Number(t), slot: 0, text, score: 1.0 })
const segCases = [
  { name: '相隔 4.5s 并成一段（前摇+后摇=5.0）', events: [ev(113.0), ev(117.5)], expectSegs: 1, gap: 5.0 },
  { name: '相隔 5.5s 分成两段且无重叠', events: [ev(113.0), ev(118.5)], expectSegs: 2, gap: 5.0 },
  { name: '相隔 4.0s 并成一段', events: [ev(100.0), ev(104.0)], expectSegs: 1, gap: 5.0 },
  { name: '相隔 9s 分成两段且无重叠', events: [ev(50.0), ev(59.0)], expectSegs: 2, gap: 5.0 },
  { name: '阈值 4.5 时 4.5s 间隔不合并（回归保护）', events: [ev(113.0), ev(117.5)], expectSegs: 2, gap: 4.5 },
  { name: '上限截断后仍保留最后一杀的后摇', events: [ev(109.5), ev(113.0), ev(117.5)], expectSegs: 1, gap: 5.0, expectEnd: 119.0 },
  { name: '开头不足前摇的击杀被丢弃', events: [ev(2.0), ev(40.0)], expectSegs: 1, gap: 5.0 }
]
for (const c of segCases) {
  const segs = highlightSegments(c.events, { pre: 3.5, post: 1.5, mergeGap: c.gap, maxDuration: 12.0 })
  let overlap = false
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].end > segs[i + 1].start + 1e-9) overlap = true
  }
  let ok = segs.length === c.expectSegs && !overlap
  if (ok && c.expectEnd !== undefined) ok = Math.abs(segs[segs.length - 1].end - c.expectEnd) < 1e-6
  if (!ok) failed++
  const endInfo = segs.length > 0 ? segs[segs.length - 1].end.toFixed(2) : '-'
  console.log(`${ok ? '[PASS]' : '[FAIL]'}  ${c.name.padEnd(30)} 段数 ${segs.length}（期望 ${c.expectSegs}） 重叠=${overlap} 末段终点=${endInfo}`)
}
console.log()

// ── psRound / ROI：PowerShell 取整语义（§11.3 的坑）──────────────────
const ratioCases = [
  { value: 172.5, digits: 0, expect: 172 }, // 1080p 的 slotY：PS 舍入到偶数
  { value: 133.5, digits: 0, expect: 134 },
  { value: 37.5, digits: 0, expect: 38 },
  { value: 187.5, digits: 0, expect: 188 },
  { value: 2.5, digits: 0, expect: 2 },
  { value: 3.5, digits: 0, expect: 4 },
  { value: 0.6944444, digits: 4, expect: 0.6944 }
]
for (const c of ratioCases) {
  const got = psRound(c.value, c.digits)
  const ok = Math.abs(got - c.expect) < 1e-12
  if (!ok) failed++
  console.log(`${ok ? '[PASS]' : '[FAIL]'}  psRound(${c.value}, ${c.digits}) = ${got}（期望 ${c.expect}）`)
}

// 与 README 记录的 ROI 对照表一致：1080p = x=1350 w=570 h=38 slots=94,134,172
const roiCases = [
  { w: 2560, h: 1440, expect: { x: 1800, w: 760, h: 50, slots: [125, 178, 230], profile: 'ref-1440p' } },
  { w: 1920, h: 1080, expect: { x: 1350, w: 570, h: 38, slots: [94, 134, 172], profile: 'scaled-1920x1080' } },
  { w: 3840, h: 2160, expect: { x: 2700, w: 1140, h: 75, slots: [188, 267, 345], profile: 'scaled-3840x2160' } },
  { w: 3440, h: 1440, expect: { x: 2680, w: 760, h: 50, slots: [125, 178, 230], profile: 'ref-1440p' } },
  { w: 1920, h: 1200, expect: { x: 1287, w: 633, h: 42, slots: [104, 148, 192], profile: 'scaled-1920x1200' } }
]
for (const c of roiCases) {
  const r = roiFor(c.w, c.h)
  const got = { x: r.x, w: r.w, h: r.h, slots: r.slots, profile: r.profile }
  const ok = JSON.stringify(got) === JSON.stringify(c.expect)
  if (!ok) failed++
  console.log(`${ok ? '[PASS]' : '[FAIL]'}  ROI ${c.w}x${c.h} → ${JSON.stringify(got)}${ok ? '' : `（期望 ${JSON.stringify(c.expect)}）`}`)
}
console.log()

if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
} else {
  console.log(`全部通过（事件 ${killCases.length} + 匹配 ${matchCases.length} + 金框 ${markerCases.length + channelCases.length} + 变体 ${variantCases.length} + ID 推断 ${idCases.length} + 分段 ${segCases.length} + 取整/ROI ${ratioCases.length + roiCases.length}）`)
}

