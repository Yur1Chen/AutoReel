#!/usr/bin/env node
/**
 * scripts/bench-kfocr-filter.mjs —— 校准（并复核）kfocr 的「前置空槽过滤」阈值。
 *
 * kfocr 判空用的是两个像素特征：
 *   color  = 击杀条底色（青绿 + 红）占比
 *   yellow = 行首淡黄头像框占比（兜底：有金框就不算空槽）
 * 阈值写死在 kfocr/src/main.rs（color < 0.06 且 yellow < 0.01 才跳过推理）。
 * 换地图 / HUD 缩放 / 游戏版本后想确认它没有把真击杀帧判空，就跑这个脚本。
 *
 * 用法：
 *   1) 先留一份「不过滤」的现场：
 *      node scripts/highlight.mjs --source <录像> --release --keep-work \
 *           --work C:\tmp\probe --no-prefilter --no-dedup
 *   2) 再跑：
 *      node scripts/bench-kfocr-filter.mjs --work C:\tmp\probe [--local-id 乐邦詹士]
 *
 * 输出：
 *   - 真击杀帧 / 噪声帧 / 空槽帧 三类的特征分位
 *   - color 阈值扫描：每个阈值会「丢掉几个真击杀帧」和「砍掉几个空槽」
 *   - 结论：当前默认阈值在这份素材上是否安全（丢真击杀帧 = 0 才算安全）
 *
 * 退出码：默认阈值会丢真击杀帧时返回 1（能直接放进 CI 当回归）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeKillText } from './lib/events.mjs'
import { cleanupCapture, runProcess } from './lib/proc.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

const DEFAULT_MIN_COLOR = 0.06
const DEFAULT_MIN_YELLOW = 0.01

function parseArgs (argv) {
  const opts = { work: undefined, ocr: undefined, localId: 'auto', scanFps: 2, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--work') opts.work = argv[++i]
    else if (a === '--ocr') opts.ocr = argv[++i]
    else if (a === '--local-id') opts.localId = argv[++i]
    else if (a === '--scan-fps') opts.scanFps = Number(argv[++i])
    else if (a === '-h' || a === '--help') {
      console.log('用法：node scripts/bench-kfocr-filter.mjs --work <含 slots/ 与 rows.json 的目录> [--local-id <ID>]')
      process.exit(0)
    } else throw new Error(`未知参数: ${a}`)
  }
  if (!opts.work) throw new Error('缺少 --work <中间产物目录>（先用 --keep-work --no-prefilter 跑一遍）')
  return opts
}

const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : '-')
const quantile = (arr, p) => {
  if (arr.length === 0) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const work = path.resolve(opts.work)
  const rowsFile = path.join(work, 'rows.json')
  const rows = JSON.parse((await fs.readFile(rowsFile, 'utf8')).replace(/^\uFEFF/, ''))

  // 本机 ID：显式给，或者按「行首金框 + 文本前缀」的老办法从 rows 里推
  let localId = opts.localId
  if (localId === 'auto') {
    const texts = rows.filter(r => r.text).map(r => r.text)
    // 退化处理：取出现频次最高的公共前缀，够用就行（这里只是分类标注，不参与成片判定）
    const prefix = [...new Set(texts)].sort((a, b) => texts.filter(t => t.startsWith(b)).length - texts.filter(t => t.startsWith(a)).length)[0] ?? ''
    localId = prefix.slice(0, 4)
    if (!localId) throw new Error('无法从 rows.json 推断本机 ID，请用 --local-id 指定')
  }

  const ocrExe = opts.ocr || path.join(ROOT, 'kfocr', 'target', 'release', 'kfocr.exe')
  const fps = Number.isFinite(opts.scanFps) && opts.scanFps > 0 ? opts.scanFps : 2

  // 帧清单（只取 slots/<槽位>/<序号>.png），再让 kfocr 只做特征采样
  const paths = []
  for (const slotDir of (await fs.readdir(path.join(work, 'slots'))).sort()) {
    const dir = path.join(work, 'slots', slotDir)
    const names = (await fs.readdir(dir)).filter(n => n.toLowerCase().endsWith('.png')).sort()
    for (const name of names) paths.push(path.join(dir, name))
  }
  const listFile = path.join(work, 'stats_list.txt')
  await fs.writeFile(listFile, paths.join('\n'), 'utf8')
  const { stdout } = await runProcess(ocrExe, ['--stats', '--list', listFile])
  await fs.rm(listFile, { force: true })

  const feats = new Map()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('S\t')) continue
    const [, file, , ink, , , yellow, , color] = line.split('\t')
    feats.set(file, { color: Number(color), yellow: Number(yellow), ink: Number(ink) })
  }

  // 标注：命中本机 ID 的行 → 必须保留；其余有文本的帧 → 噪声（丢不丢无所谓）
  const hits = new Map()
  const anyText = new Set()
  for (const r of rows) {
    if (!r.path || !r.text) continue
    anyText.add(r.path)
    if (normalizeKillText(r.text, localId)) hits.set(r.path, (hits.get(r.path) ?? 0) + 1)
  }
  const buckets = { hit: [], noise: [], empty: [] }
  let missing = 0
  for (const file of paths) {
    const f = feats.get(file)
    if (!f) { missing++; continue }
    if (hits.get(file)) buckets.hit.push(f)
    else if (anyText.has(file)) buckets.noise.push(f)
    else buckets.empty.push(f)
  }

  console.log(`素材目录: ${work}`)
  console.log(`本机 ID : ${localId}   帧数: ${paths.length}（特征缺失 ${missing}）  fps=${fps}`)
  console.log(`  有本地击杀行 ${buckets.hit.length} 帧 / 只有噪声行 ${buckets.noise.length} 帧 / 空槽 ${buckets.empty.length} 帧`)

  for (const key of ['color', 'yellow']) {
    console.log(`\n== ${key} ==`)
    for (const [name, arr] of Object.entries(buckets)) {
      if (arr.length === 0) continue
      const vs = arr.map(f => f[key])
      console.log(`  ${name.padEnd(6)}: min=${fmt(Math.min(...vs))} p05=${fmt(quantile(vs, 0.05))} p50=${fmt(quantile(vs, 0.5))} p95=${fmt(quantile(vs, 0.95))} max=${fmt(Math.max(...vs))}`)
    }
  }

  console.log('\n== color 阈值扫描（判空 = color < t 且 yellow < 默认值）==')
  const grid = [0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12]
  for (const t of grid) {
    const mark = Math.abs(t - DEFAULT_MIN_COLOR) < 1e-9 ? ' ← 当前默认' : ''
    const lost = buckets.hit.filter(f => f.color < t && f.yellow < DEFAULT_MIN_YELLOW).length
    const cut = buckets.empty.filter(f => f.color < t && f.yellow < DEFAULT_MIN_YELLOW).length
    const keptNoise = buckets.noise.length - buckets.noise.filter(f => f.color < t && f.yellow < DEFAULT_MIN_YELLOW).length
    console.log(`  t=${t.toFixed(3)}  丢真击杀帧 ${lost}/${buckets.hit.length}  砍空槽 ${cut}/${buckets.empty.length}`
      + `  仍需推理 ${buckets.hit.length - lost + keptNoise} 张${mark}`)
  }

  const lostAtDefault = buckets.hit.filter(f => f.color < DEFAULT_MIN_COLOR && f.yellow < DEFAULT_MIN_YELLOW).length
  const minHit = buckets.hit.length > 0 ? Math.min(...buckets.hit.map(f => f.color)) : NaN
  console.log(`\n结论：默认阈值(color<${DEFAULT_MIN_COLOR} 且 yellow<${DEFAULT_MIN_YELLOW})`
    + ` 在这份素材上丢掉 ${lostAtDefault} 个真击杀帧`
    + `；真击杀帧的 color 最小值 ${fmt(minHit)}（余量 ${fmt(minHit / DEFAULT_MIN_COLOR, 2)}×）`)
  return lostAtDefault === 0 ? 0 : 1
}

main()
  .then(code => { process.exitCode = code })
  .catch(err => {
    process.stderr.write(`[bench-kfocr-filter.mjs] ${err?.message ?? err}\n`)
    process.exitCode = 2
  })
  .finally(() => cleanupCapture())
