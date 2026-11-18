/**
 * scripts/test-parity.mjs —— 金样比对：同一素材分别用 PS 引擎和 JS 引擎跑一遍，
 * 逐条比较 localId / kills / segments / 成片 SHA256。
 *
 * 做法：PS 版先跑（-KeepWork 留下 slots 与 rows.json），JS 版用 --reuse 复用同一份
 * 抽帧与 OCR 结果，这样两边的输入完全相同，差异只可能来自判定逻辑或编排层。
 *
 * 用法：
 *   node scripts/test-parity.mjs                      # 默认 6 条已有成片的素材
 *   node scripts/test-parity.mjs --source <a> --source <b>
 *   node scripts/test-parity.mjs --keep               # 保留中间产物（默认通过后删除）
 *
 * 退出码：全部一致 0，否则 1。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupCapture, runProcess } from './lib/proc.mjs'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(SCRIPTS)
const REPLAY_DIR = path.join(process.env.USERPROFILE ?? '', 'Videos', 'VALORANT')

const DEFAULT_SOURCES = [
  'Valorant 2025.09.14 - 10.48.16.04.DVR.mp4',
  'Valorant 2025.09.21 - 17.16.07.08.DVR.mp4',
  'Valorant 2026.10.13 - 19.52.39.02.DVR.mp4',
  'Valorant 2026.11.11 - 23.18.09.02.DVR.mp4',
  'Valorant 2026.11.11 - 23.18.37.03.DVR.mp4',
  'Valorant 2026.11.11 - 23.21.53.04.DVR.mp4'
]

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const sources = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--source') sources.push(argv[++i])
}
const list = sources.length > 0 ? sources : DEFAULT_SOURCES.map(n => path.join(REPLAY_DIR, n))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseEvents (stdout) {
  const events = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('HC ')) continue
    try { events.push(JSON.parse(line.slice(3))) } catch {}
  }
  return events
}

const byName = (events, name) => events.find(e => e.ev === name)
const sha256 = async file => {
  const hash = crypto.createHash('sha256')
  hash.update(await fs.readFile(file))
  return hash.digest('hex').toUpperCase()
}

function fmtKill (k) {
  return `${k.t}s ${k.text}`
}

/** 比较两边的事件，返回差异描述数组（空 = 一致）。 */
function compare (ps, js, psHash, jsHash) {
  const diffs = []
  const psId = byName(ps, 'localId')?.id
  const jsId = byName(js, 'localId')?.id
  if (psId !== jsId) diffs.push(`localId: PS=${psId} JS=${jsId}`)

  const pk = byName(ps, 'kills')?.kills ?? []
  const jk = byName(js, 'kills')?.kills ?? []
  if (pk.length !== jk.length) diffs.push(`击杀数: PS=${pk.length} JS=${jk.length}`)
  for (let i = 0; i < Math.min(pk.length, jk.length); i++) {
    const a = pk[i]
    const b = jk[i]
    if (a.t !== b.t || a.text !== b.text || a.slot !== b.slot || Math.abs(a.score - b.score) > 1e-9) {
      diffs.push(`击杀 #${i + 1}: PS=${fmtKill(a)} slot=${a.slot} score=${a.score} / JS=${fmtKill(b)} slot=${b.slot} score=${b.score}`)
    }
  }

  const pseg = byName(ps, 'segments')?.segments ?? []
  const jseg = byName(js, 'segments')?.segments ?? []
  if (pseg.length !== jseg.length) diffs.push(`段数: PS=${pseg.length} JS=${jseg.length}`)
  for (let i = 0; i < Math.min(pseg.length, jseg.length); i++) {
    const a = pseg[i]
    const b = jseg[i]
    if (Math.abs(a.start - b.start) > 1e-9 || Math.abs(a.end - b.end) > 1e-9 || a.text !== b.text) {
      diffs.push(`段 #${i + 1}: PS=${a.start}-${a.end} ${a.text} / JS=${b.start}-${b.end} ${b.text}`)
    }
  }

  const pr = byName(ps, 'result')
  const jr = byName(js, 'result')
  if (pr && jr && Math.abs(pr.duration - jr.duration) > 1e-6) {
    diffs.push(`成片时长: PS=${pr.duration} JS=${jr.duration}`)
  }
  if (psHash && jsHash && psHash !== jsHash) diffs.push(`成片 SHA256 不一致: PS=${psHash} JS=${jsHash}`)
  return diffs
}

async function runPs (src, work, out) {
  const { stdout } = await runProcess('pwsh', [
    '-NoProfile', '-File', path.join(SCRIPTS, 'highlight.ps1'),
    '-Source', src, '-Machine', '-Release',
    '-KeepWork', '-Work', work, '-Out', out
  ])
  return parseEvents(stdout)
}

async function runJs (src, work, out) {
  const { stdout } = await runProcess(process.execPath, [
    path.join(SCRIPTS, 'highlight.mjs'),
    '--source', src, '--release', '--machine',
    '--reuse', '--keep-work', '--work', work, '--out', out
  ])
  return parseEvents(stdout)
}

async function main () {
  const report = []
  let failed = 0
  for (const src of list) {
    const name = path.basename(src)
    if (!(await fs.access(src).then(() => true, () => false))) {
      console.log(`[SKIP] ${name}: 源文件不存在`)
      continue
    }
    const stem = path.basename(src, path.extname(src)).replace(/^Valorant\s+/, '').replace(/\.DVR$/, '')
    const base = path.join(ROOT, 'out', '_parity', stem)
    const work = path.join(base, 'work')
    process.stdout.write(`\n=== ${name}\n  [1/2] PS 引擎 ...`)
    const t0 = Date.now()
    const ps = await runPs(src, work, path.join(base, 'ps'))
    const psSeconds = (Date.now() - t0) / 1000
    const psHash = await sha256(path.join(work, 'highlight_reel.mp4')).catch(() => null)
    process.stdout.write(` ${psSeconds.toFixed(0)}s, ${byName(ps, 'kills')?.count ?? '?'} 杀\n  [2/2] JS 引擎 ...`)

    const t1 = Date.now()
    const js = await runJs(src, work, path.join(base, 'js'))
    const jsSeconds = (Date.now() - t1) / 1000
    const jsHash = await sha256(path.join(work, 'highlight_reel.mp4')).catch(() => null)
    process.stdout.write(` ${jsSeconds.toFixed(0)}s\n`)

    const diffs = compare(ps, js, psHash, jsHash)
    const ok = diffs.length === 0
    if (!ok) failed++
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${ok ? 'kills / segments / 成片逐字节一致' : diffs.join('\n        ')}`)
    report.push({
      source: name,
      ok,
      psSeconds: Math.round(psSeconds),
      jsSeconds: Math.round(jsSeconds),
      localId: byName(ps, 'localId')?.id,
      kills: byName(ps, 'kills')?.count,
      segments: byName(ps, 'segments')?.count,
      reelSha256: psHash,
      diffs
    })

    if (ok && !keep) {
      await fs.rm(base, { recursive: true, force: true })
    } else if (!ok) {
      console.log(`        保留现场: ${base}`)
    }
  }

  const reportFile = path.join(ROOT, 'out', '_parity', 'report.json')
  await fs.mkdir(path.dirname(reportFile), { recursive: true })
  await fs.writeFile(reportFile, JSON.stringify({ at: new Date().toISOString(), failed, report }, null, 2), 'utf8')
  console.log(`\n${failed === 0 ? '全部一致' : `${failed} 条不一致`}；报告 ${reportFile}`)
  return failed
}

main()
  .then(failed => { process.exitCode = failed === 0 ? 0 : 1 })
  .catch(err => {
    process.stderr.write(`[test-parity.mjs] ${err?.stack ?? err}\n`)
    process.exitCode = 1
  })
  .finally(() => cleanupCapture())
