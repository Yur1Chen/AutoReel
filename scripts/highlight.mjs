#!/usr/bin/env node
/**
 * scripts/highlight.mjs —— scripts/highlight.ps1 的 JS 版（引擎 JS 化，docs/PLUGIN-PLAN.md §11）。
 *
 * 一步从 NVIDIA 即时回放剪出击杀集锦：抽帧 → OCR → 重建击杀事件 → 切片 → 拼接。
 *
 * 输出只保留成片：默认写到 out/<素材名>/highlight_reel.mp4。
 * 中间产物（抽帧、OCR 结果、切片）默认放在系统临时目录，跑完自动删除；
 * 需要复用或排查时加 --keep-work，并把 --work 指到一个想保留的目录。
 *
 * 判定逻辑全部在 scripts/lib/events.mjs（与 events.ps1 逐函数对应）；
 * 外部进程只有 ffmpeg / ffprobe / kfocr，参数与 PS 版逐条一致，所以成片应当逐字节一致。
 *
 * 用法：
 *   node scripts/highlight.mjs --source "<...>.DVR.mp4" --release
 *   node scripts/highlight.mjs --source ... --local-id 乐邦詹士 --release --machine
 *
 * 参数（对应 highlight.ps1 的 -Source / -LocalId / ...）：
 *   --source <文件>        源录像
 *   --local-id <id>        本机玩家 ID，默认 auto（行首黄框推断）
 *   --scan-fps <n>         扫描帧率，默认 2
 *   --pre <秒>             击杀前留几秒，默认 3.5（0–10）
 *   --post <秒>            击杀后留几秒，默认 1.5（0–10）
 *   --ocr <exe>            kfocr 路径，默认 <repo>/kfocr/target/{release|debug}/kfocr.exe
 *   --models <目录>        OCR 模型目录；默认取环境变量 TACK_OCR_MODELS，都没有就报错
 *   --out <目录>           成片目录，默认 <repo>/out/<素材名>
 *   --work <目录>          中间产物目录，默认 <系统临时目录>/AutoReel/<素材名>
 *   --reuse                复用已有抽帧与 OCR 结果（需配合 --keep-work）
 *   --legacy-extract       每个槽位各解码一遍（旧实现，用于 A/B）
 *   --release              用 release 版 kfocr
 *   --single-ocr           每帧一个进程（旧实现，用于 A/B）
 *   --chunk-size <n>       批处理每多少次调用一个进程，默认 60
 *   --keep-work            跑完不删中间产物
 *   --machine              stdout 只输出 `HC <json>` 事件行，人读信息走 stderr
 *   --roi "x,w,h,y1,y2,y3" 击杀条 ROI override（源视频像素），默认 auto
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  autoLocalId,
  dropUnmarkedHits,
  highlightSegments,
  killEvents,
  markerChannelUsable,
  mergeVariantEvents,
  normalizeKillText
} from './lib/events.mjs'
import { cleanupCapture, runProcess } from './lib/proc.mjs'
import { roiFor } from './lib/roi.mjs'
import { psRound } from './lib/round.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

// ── 参数解析 ────────────────────────────────────────────────────
function parseArgs (argv) {
  const opts = {
    source: undefined,
    localId: 'auto',
    scanFps: 2,
    pre: 3.5,
    post: 1.5,
    ocr: undefined,
    work: undefined,
    out: undefined,
    reuse: false,
    legacyExtract: false,
    release: false,
    singleOcr: false,
    chunkSize: 60,
    keepWork: false,
    machine: false,
    roi: 'auto',
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe'
  }
  const takesValue = {
    '--source': 'source',
    '--local-id': 'localId',
    '--scan-fps': 'scanFps',
    '--pre': 'pre',
    '--post': 'post',
    '--ocr': 'ocr',
  '--models': 'models',
    '--work': 'work',
    '--out': 'out',
    '--chunk-size': 'chunkSize',
    '--roi': 'roi',
    '--ffmpeg': 'ffmpeg',
    '--ffprobe': 'ffprobe'
  }
  const flags = {
    '--reuse': 'reuse',
    '--legacy-extract': 'legacyExtract',
    '--release': 'release',
    '--single-ocr': 'singleOcr',
    '--keep-work': 'keepWork',
    '--machine': 'machine'
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (takesValue[a]) {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 缺少参数`)
      opts[takesValue[a]] = (a === '--scan-fps' || a === '--chunk-size' || a === '--pre' || a === '--post') ? Number(v) : v
    } else if (flags[a]) {
      opts[flags[a]] = true
    } else if (a === '-h' || a === '--help') {
      console.log('用法见文件头注释：node scripts/highlight.mjs --source <录像> [--release]')
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${a}`)
    }
  }
  if (!opts.source) throw new Error('缺少 --source <源录像>')
  return opts
}

const opts = parseArgs(process.argv.slice(2))

// ── 输出：人读信息 vs 机器事件 ──────────────────────────────────
// --machine 时 stdout 必须干净（只有 HC 行），否则插件解析会被日志污染。
function note (text = '') {
  if (opts.machine) process.stderr.write(`${text}\n`)
  else process.stdout.write(`${text}\n`)
}

function emit (name, data = {}) {
  if (!opts.machine) return
  process.stdout.write(`HC ${JSON.stringify({ ev: name, ...data })}\n`)
}

// ── 外部进程：见 lib/proc.mjs（用临时文件收输出，避开沙箱的管道限制）────────
async function exists (p) {
  try { await fs.access(p); return true } catch { return false }
}

async function ensureDir (p) {
  await fs.mkdir(p, { recursive: true })
}

// ── 击杀条 ROI：按源视频规格自适应（见 lib/roi.mjs）────────────────
async function probeMedia (file) {
  const { stdout } = await runProcess(opts.ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate',
    '-of', 'default=nw=1', file
  ])
  let width = 0
  let height = 0
  let fps = 60
  for (const line of stdout.split(/\r?\n/)) {
    let m
    if ((m = /^width=(\d+)/.exec(line))) width = Number(m[1])
    else if ((m = /^height=(\d+)/.exec(line))) height = Number(m[1])
    else if ((m = /^avg_frame_rate=(\d+)\/(\d+)/.exec(line)) && Number(m[2]) > 0) fps = Math.trunc(Number(m[1]) / Number(m[2]))
  }
  if (width <= 0 || height <= 0) throw new Error(`无法读取视频分辨率（ffprobe 失败）: ${file}`)
  return { width, height, fps }
}

async function main () {
  const source = path.resolve(opts.source)
  let ocrExe = opts.ocr
  if (!ocrExe) {
    ocrExe = path.join(ROOT, 'kfocr', 'target', opts.release ? 'release' : 'debug', 'kfocr.exe')
  }
  if (!(await exists(source))) throw new Error(`源录像不存在: ${source}`)
  if (!(await exists(ocrExe))) throw new Error(`OCR 可执行文件不存在: ${ocrExe}  （先 cargo build --offline）`)

  // 模型目录：--models > TACK_OCR_MODELS，都没有就报错（不再回落到作者机器的路径）
  const modelsArg = opts.models || process.env.TACK_OCR_MODELS
  if (!modelsArg) {
    throw new Error('缺少 OCR 模型目录：用 --models <目录> 或环境变量 TACK_OCR_MODELS 指定'
      + '（目录里需 det.rten / rec.rten / ppocrv6_dict.txt，见 THIRD_PARTY.md）')
  }
  const modelsDir = path.resolve(modelsArg)
  if (!(await exists(modelsDir))) throw new Error(`OCR 模型目录不存在: ${modelsDir}`)

  // 素材名：去掉 "Valorant " 前缀和 ".DVR" 后缀，作为输出目录名
  const stem = path.basename(source, path.extname(source)).replace(/^Valorant\s+/, '').replace(/\.DVR$/, '')
  const outDir = opts.out ? path.resolve(opts.out) : path.join(ROOT, 'out', stem)
  // 中间产物默认进系统临时目录：用户只需要成片，这些文件不该出现在 out/ 里
  const workDir = opts.work ? path.resolve(opts.work) : path.join(os.tmpdir(), 'AutoReel', stem)

  const PRE = opts.pre
  const POST = opts.post
  if (!Number.isFinite(PRE) || !Number.isFinite(POST) || PRE < 0 || POST < 0 || PRE > 10 || POST > 10) {
    throw new Error(`--pre / --post 需要 0–10 的秒数（收到 pre=${opts.pre} post=${opts.post}）`)
  }
  const MERGE = PRE + POST
  const MAXSEG = 12.0
  const started = Date.now()
  const elapsed = () => psRound((Date.now() - started) / 1000, 1)

  const media = await probeMedia(source)
  const roi = roiFor(media.width, media.height)
  let { x: slotX, w: slotW, h: slotH, slots, profile: roiProfile } = roi

  // 显式覆盖：--roi "x,w,h,y1,y2,y3"
  if (opts.roi && opts.roi !== 'auto') {
    const p = opts.roi.split(',').map(s => Number(s.trim()))
    if (p.length < 6 || p.some(Number.isNaN)) throw new Error(`--roi 需要 6 个整数: x,w,h,y1,y2,y3（收到: ${opts.roi}）`)
    slotX = p[0]; slotW = p[1]; slotH = p[2]; slots = [p[3], p[4], p[5]]
    roiProfile = 'explicit'
  }

  emit('media', {
    width: media.width,
    height: media.height,
    fps: media.fps,
    scale: psRound(roi.scale, 4),
    profile: roiProfile,
    roi: { x: slotX, w: slotW, h: slotH, slots }
  })

  // ── 1/4 抽帧 ─────────────────────────────────────────────────
  emit('stage', { name: 'extract', pct: 0, text: `抽帧 fps=${opts.scanFps}` })

  const reuse = opts.reuse && (await exists(path.join(workDir, 'slots')))
  if (reuse) {
    note(`[0/4] --reuse：沿用 ${workDir} 下已有的抽帧与 OCR 结果`)
  } else {
    await fs.rm(workDir, { recursive: true, force: true })
  }
  // clips 每次都要重建：--reuse 只复用抽帧与 OCR，切片必须重新生成，否则上一轮的旧片段会残留
  await fs.rm(path.join(workDir, 'clips'), { recursive: true, force: true })
  await ensureDir(path.join(workDir, 'slots'))
  await ensureDir(path.join(workDir, 'clips'))

  note(`[1/4] 抽帧 fps=${opts.scanFps}（单次解码 + split=${slots.length}，文档 §8.2）...`)
  if (opts.reuse && (await exists(path.join(workDir, 'slots', '0', '0001.png')))) {
    note('   复用已有抽帧')
    emit('progress', { pct: 10, text: '复用已有抽帧' })
  } else {
    for (let s = 0; s < slots.length; s++) await ensureDir(path.join(workDir, 'slots', String(s)))
    const t0 = Date.now()
    if (opts.legacyExtract) {
      // 旧实现：每个槽位各跑一次 ffmpeg，每次都完整解码整片
      for (let s = 0; s < slots.length; s++) {
        await runProcess(opts.ffmpeg, [
          '-y', '-v', 'error', '-i', source,
          '-vf', `fps=${opts.scanFps},crop=${slotW}:${slotH}:${slotX}:${slots[s]}`,
          path.join(workDir, 'slots', String(s), '%04d.png')
        ])
      }
    } else {
      // 单次解码 + split=N，每条分支只裁自己那条 ROI
      const branches = slots.map((_, i) => `[b${i}]`)
      const graph = [`fps=${opts.scanFps},split=${slots.length}${branches.join('')}`]
      for (let s = 0; s < slots.length; s++) {
        graph.push(`${branches[s]}crop=${slotW}:${slotH}:${slotX}:${slots[s]}[s${s}]`)
      }
      const fgFile = path.join(workDir, 'fg.txt')
      await fs.writeFile(fgFile, graph.join(';'), 'ascii')

      const mapArgs = []
      for (let s = 0; s < slots.length; s++) {
        mapArgs.push('-map', `[s${s}]`, path.join(workDir, 'slots', String(s), '%04d.png'))
      }
      await runProcess(opts.ffmpeg, ['-y', '-v', 'error', '-i', source, '-/filter_complex', fgFile, ...mapArgs])
    }
    const extractSeconds = (Date.now() - t0) / 1000
    note(`   抽帧耗时 ${extractSeconds.toFixed(2)}s`)
    emit('progress', { pct: 10, text: `抽帧完成 ${extractSeconds.toFixed(1)}s` })
  }

  // ── 2/4 OCR ──────────────────────────────────────────────────
  note('[2/4] OCR ...')
  note(`   引擎: ${ocrExe}`)
  note(`   模型: ${modelsDir}`)
  // 缓存的是「所有识别到的行」（未按 ID 过滤），这样 --local-id auto 和换 ID 重跑都不用重跑 OCR
  const rowsFile = path.join(workDir, 'rows.json')
  let rows
  if (opts.reuse && (await exists(rowsFile))) {
    const parsed = JSON.parse((await fs.readFile(rowsFile, 'utf8')).replace(/^\uFEFF/, ''))
    rows = Array.isArray(parsed) ? parsed : [parsed]
    note(`   复用 rows.json，识别到 ${rows.length} 行`)
    emit('progress', { pct: 65, text: `复用 OCR 结果 ${rows.length} 行` })
  } else {
    const swOcr = Date.now()
    rows = []
    let scanned = 0

    // 帧元数据：路径 -> (slot, t)
    const frameMeta = new Map()
    const paths = []
    for (let s = 0; s < slots.length; s++) {
      const dir = path.join(workDir, 'slots', String(s))
      const names = (await fs.readdir(dir)).filter(n => n.toLowerCase().endsWith('.png')).sort()
      for (const name of names) {
        const full = path.join(dir, name)
        frameMeta.set(full, { slot: s, t: (Number.parseInt(path.basename(name, '.png'), 10) - 1) / opts.scanFps })
        paths.push(full)
      }
    }

    const addRow = (file, tsvLine) => {
      const p = tsvLine.split('\t')
      if (p.length < 7) return
      const m = frameMeta.get(file)
      if (!m) return
      rows.push({ t: psRound(m.t, 2), slot: m.slot, text: p[6], score: Number(p[5]), path: file })
    }

    if (opts.singleOcr) {
      // 每帧一次进程（旧实现，用于 A/B 对比）
      for (const file of paths) {
        scanned++
        const { stdout } = await runProcess(ocrExe, ['--models', modelsDir, file])
        for (const line of stdout.split(/\r?\n/)) if (line) addRow(file, line)
      }
    } else {
      // 批量：路径写进清单，一次进程内处理，模型只加载一次。
      // 但单个长进程会随时间劣化（实测 720 帧一次跑 126-133ms/帧，拆成 6×120 只要 90ms/帧），
      // 所以按 chunkSize 分段调用。
      scanned = paths.length
      const chunkCount = Math.ceil(paths.length / opts.chunkSize)
      for (let c = 0; c < chunkCount; c++) {
        const from = c * opts.chunkSize
        const to = Math.min(paths.length - 1, from + opts.chunkSize - 1)
        const listFile = path.join(workDir, `ocr_list_${c}.txt`)
        await fs.writeFile(listFile, paths.slice(from, to + 1).join('\n'), 'utf8')
        const { stdout } = await runProcess(ocrExe, ['--quiet', '--models', modelsDir, '--list', listFile])
        let cur = null
        for (const line of stdout.split(/\r?\n/)) {
          if (!line) continue
          if (line.startsWith('F\t')) { cur = line.slice(2); continue }
          if (!cur) continue
          addRow(cur, line)
        }
        const done = Math.min(to + 1, paths.length)
        const pct = 10 + 55.0 * done / Math.max(1, paths.length)
        emit('progress', { pct: psRound(pct, 1), text: `OCR ${done}/${paths.length}` })
      }
    }

    await fs.writeFile(rowsFile, JSON.stringify(rows, null, 2), 'utf8')
    const ocrSeconds = (Date.now() - swOcr) / 1000
    note(`   识别 ${scanned} 张，得到 ${rows.length} 行文本，OCR 耗时 ${ocrSeconds.toFixed(1)}s（单张 ${Math.round((ocrSeconds * 1000) / Math.max(1, scanned))}ms）`)
    emit('progress', { pct: 65, text: `OCR 完成 ${scanned} 张 / ${rows.length} 行，${ocrSeconds.toFixed(1)}s` })
  }

  // ── 行首金框：既用来推断本机 ID，也用来逐行否决（BUGS #1 / TODO #1）─────────
  // 本机玩家的头像框是淡黄色：「出现在行首」= 这次击杀是本机打的，「出现在行尾」= 本机被杀。
  // 敌方红框、队友青框都不命中这套颜色判据，所以它是「本机 ID 在杀手位」的直接证据，
  // 比文本顺序可靠。kfocr --marker 只做像素采样（不加载模型），对「有文本的行」全量算一次。
  emit('stage', { name: 'detect', pct: 65, text: '重建击杀事件' })
  const markerPaths = [...new Set(rows.filter(r => r.text && r.path).map(r => r.path))]
  const markerMap = new Map()
  if (markerPaths.length > 0) {
    const listFile = path.join(workDir, 'marker_list.txt')
    await fs.writeFile(listFile, markerPaths.join('\n'), 'utf8')
    const { stdout } = await runProcess(ocrExe, ['--quiet', '--marker', '0.5', '--list', listFile])
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith('M\t')) continue
      const [, file, score] = line.split('\t')
      markerMap.set(file, Number(score))
    }
  }

  // 本地玩家 ID：显式指定，或 auto 从「行首金框」的那些行推断
  let localId = opts.localId
  if (localId === 'auto') {
    // 只对「有文本的行」采样，和 PS 的 Get-AutoLocalId 一致
    if (markerPaths.length > 0 && markerMap.size === 0) {
      // 旧版 kfocr 把 --marker 当成图片路径，stdout 不会有 M 行；点名让人重建，别只报「样本不足」
      throw new Error('kfocr 没有输出 --marker 结果（需要带 --marker 的新构建：cd kfocr && cargo build --release --offline）')
    }
    const autoId = autoLocalId(rows, p => markerMap.get(p) ?? 0)
    if (!autoId) {
      throw new Error('无法自动判定本地玩家 ID（带标记得的击杀样本不足），请用 --local-id <你的ID> 显式指定')
    }
    localId = autoId
    note(`   自动判定本地 ID: ${localId}`)
  }
  emit('localId', { id: localId })

  // 文本归一化只能证明「本机 ID 在这一行开头」，证明不了它在杀手位；金框可用时再逐行否决一遍。
  const markerOn = markerChannelUsable([...markerMap.values()])
  if (!markerOn) {
    note('   !! 行首金框不可用（ROI 没框住头像框 / kfocr 不支持 --marker），本次退回纯文本判定')
  }
  const candidates = []
  for (const r of rows) {
    const norm = normalizeKillText(r.text, localId)
    if (!norm || norm.length < 3) continue
    candidates.push({
      t: r.t, slot: r.slot, text: norm, score: r.score, raw: r.text, marker: markerMap.get(r.path) ?? 0
    })
  }
  const { kept: hits, dropped } = markerOn
    ? dropUnmarkedHits(candidates)
    : { kept: candidates, dropped: [] }
  for (const d of dropped) {
    note(`   [否决] ${d.t.toFixed(2).padStart(7)}s 行首无金框  ${JSON.stringify(d.raw)} → ${JSON.stringify(d.text)}`)
  }
  note(`   命中本地玩家击杀的行 ${hits.length} 条${dropped.length > 0 ? `（行首无金框否决 ${dropped.length} 条）` : ''}`)

  // ── 3/4 按屏幕占位重建 → 击杀事件 ──────────────────────────────
  note('[3/4] 按屏幕占位重建 -> 击杀事件 ...')
  // 判定逻辑见 scripts/lib/events.mjs：killfeed 是队列，同一条文本可以合法地出现多次
  // （贤者复活、暮蝶自我复活都会让同一个敌人一回合内被杀多次，一回合最多 7 杀）。
  let events = killEvents(hits, { mergeGap: 3.0, maxAppearance: 6.0 })
  events = mergeVariantEvents(events, { maxGap: 1.5, maxDistance: 1 })
  for (const e of events) note(`   ${e.t.toFixed(2).padStart(7)}  slot=${e.slot}  ${e.score.toFixed(3)}  ${e.text}`)
  emit('kills', {
    count: events.length,
    kills: events.map(e => ({ t: e.t, text: e.text, slot: e.slot, score: e.score }))
  })

  // ── 4/4 切片 + 拼接 ──────────────────────────────────────────
  note('[4/4] 切片 + 拼接 ...')
  const segs = highlightSegments(events, { pre: PRE, post: POST, mergeGap: MERGE, maxDuration: MAXSEG })

  const listFile = path.join(workDir, 'list.txt')
  await fs.rm(listFile, { force: true })
  await fs.writeFile(listFile, '', 'utf8')
  const swCut = Date.now()
  let i = 0
  for (const sg of segs) {
    i++
    const dur = psRound(sg.end - sg.start, 2)
    const clipPath = path.join(workDir, 'clips', `k${String(i).padStart(2, '0')}.mp4`)
    note(`   #${i}  ${sg.start.toFixed(2).padStart(7)}s +${dur.toFixed(2).padStart(5)}s  ${sg.text}`)
    await runProcess(opts.ffmpeg, [
      '-y', '-v', 'error',
      '-ss', String(sg.start), '-i', source, '-t', String(dur),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      clipPath
    ])
    if (!(await exists(clipPath))) { note(`   !! 切片失败 ${clipPath}`); continue }
    await fs.appendFile(listFile, `file '${clipPath.replace(/\\/g, '/')}'\n`, 'utf8')
    const pct = segs.length > 0 ? 70 + 25.0 * i / segs.length : 95
    emit('progress', { pct: psRound(pct, 1), text: `切片 ${i}/${segs.length}` })
  }

  const reel = path.join(workDir, 'highlight_reel.mp4')
  await runProcess(opts.ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', reel])
  note(`   切片 + 拼接耗时 ${((Date.now() - swCut) / 1000).toFixed(1)}s`)

  // ── kills.json（文档 §7.1 的中间接口）────────────────────────
  const meta = {
    source: path.basename(source),
    profile: roiProfile,
    width: media.width,
    height: media.height,
    fps: media.fps,
    scan_fps: opts.scanFps,
    pre: PRE,
    post: POST,
    roi: { x: slotX, w: slotW, h: slotH, slots },
    kills: events.map(e => ({ t: e.t, text: e.text, slot: e.slot, score: e.score }))
  }
  await fs.writeFile(path.join(workDir, 'kills.json'), JSON.stringify(meta, null, 2), 'utf8')

  if (!(await exists(reel))) throw new Error('拼接失败')

  // ── 只把成片交出去：out/<素材名>/highlight_reel.mp4 ───────────────
  const { stdout: durOut } = await runProcess(opts.ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', reel
  ])
  const durSec = psRound(Number.parseFloat(durOut.trim()), 2)
  await ensureDir(outDir)
  const final = path.join(outDir, 'highlight_reel.mp4')
  await fs.copyFile(reel, final)
  const sizeMb = psRound((await fs.stat(final)).size / (1024 * 1024), 1)

  emit('segments', {
    count: segs.length,
    segments: segs.map(s => ({ start: psRound(s.start, 2), end: psRound(s.end, 2), text: s.text }))
  })
  emit('result', {
    output: final,
    stem,
    duration: durSec,
    width: media.width,
    height: media.height,
    profile: roiProfile,
    scanFps: opts.scanFps,
    localId,
    kills: events.length,
    segments: segs.length,
    sizeMb,
    elapsed: elapsed()
  })

  // 中间产物（抽帧、OCR 结果、切片、kills.json）默认删掉：这些对使用者没有意义
  if (!opts.keepWork) {
    await fs.rm(workDir, { recursive: true, force: true })
    // 顺手清掉空掉的父目录（<temp>/AutoReel），别在临时目录里留壳
    const parent = path.dirname(workDir)
    try {
      const left = await fs.readdir(parent)
      if (left.length === 0) await fs.rmdir(parent)
    } catch {}
  }

  note('')
  note(`成片: ${final}`)
  note(`      ${durSec} s   ${events.length} 次击杀 → ${segs.length} 段   ${sizeMb.toFixed(1)} MB   总耗时 ${elapsed().toFixed(1)}s`)
  if (opts.keepWork) note(`      中间产物: ${workDir}`)
}

main()
  .catch(err => {
    process.stderr.write(`[highlight.mjs] ${err?.message ?? err}\n`)
    process.exitCode = 1
  })
  .finally(() => cleanupCapture())

