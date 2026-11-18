/**
 * AutoReel 的 Host 半：一个工具、一个后台作业生产者、几条本机 HTTP 路由。
 *
 * 设计要点（见 docs/PLUGIN-PLAN.md）：
 * - 引擎是现有 scripts/highlight.ps1 的 -Machine 模式，本文件只解释事件；
 * - 长任务走 ctx.jobs（有进度、可取消、不阻塞 tool 调用到底）；
 * - 浏览器侧数据走 ctx.webServer 路由（自定义 @Remote 需要 typert 代码生成，bundle 用不了）。
 */
import path from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn, execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import { runPipeline } from './lib/engine.js'
import { sendJson, sendText, readJsonBody, serveFile } from './lib/http.js'
import { listReplays, latestReplay, listReels, stemOf } from './lib/replays.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const REEL_NAME = 'highlight_reel.mp4'
const VERSION = '0.1.0'
// webServer 的 prefix 匹配是 `pathname === prefix || startsWith(prefix + '/')`，
// 所以注册值不能带尾斜杠；拼 URL 时才加。
const MEDIA_ROUTE = '/autoreel/media'
const MEDIA_PREFIX = `${MEDIA_ROUTE}/`
const RUNS_ROUTE = '/autoreel/api/runs'

/** 插件名（Loader 行 id 由 cordis.patch.yml 决定，这里只给作业与日志用）。 */
export const name = 'auto-reel'
/**
 * Cordis 要求声明后才能取服务（否则报 `cannot get property "..." without inject`）。
 * 三个服务都是这个 Web/Desktop 组合里的常驻项：没有它们，这个插件本来也没意义。
 */
export const inject = ['tools', 'webServer', 'jobs', 'clientModules']

function pick (value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/** 第一个存在的候选路径；都没有就返回 fallback（用于"仓库布局"和"打包布局"二选一）。 */
function firstExisting (candidates, fallback) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return fallback
}

function positive (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 配置合并：patch 里的 config 覆盖默认值，默认值优先找包内自带的那份。 */
function resolveConfig (raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const localAppData = process.env.LOCALAPPDATA || home
  return {
    replaysDir: pick(c.replaysDir, home ? path.join(home, 'Videos', 'VALORANT') : ''),
    // 仓库布局用 <repo>/out（和 CLI 产物放在一起）；打包安装时回落到用户目录。
    outputDir: pick(c.outputDir, firstExisting(
      [path.join(REPO, 'out')],
      path.join(localAppData, 'AutoReel', 'out')
    )),
    // 打包版把引擎放在 <包>/engine，仓库版在 <repo>/scripts。
    // scriptPath 是 PS 回落引擎；engineScript 是默认的 JS 引擎（不需要 PowerShell）。
    scriptPath: pick(c.scriptPath, firstExisting(
      [path.join(HERE, 'engine', 'highlight.ps1'), path.join(REPO, 'scripts', 'highlight.ps1')],
      path.join(REPO, 'scripts', 'highlight.ps1')
    )),
    engineScript: pick(c.engineScript, firstExisting(
      [path.join(HERE, 'engine', 'highlight.mjs'), path.join(REPO, 'scripts', 'highlight.mjs')],
      path.join(REPO, 'scripts', 'highlight.mjs')
    )),
    // auto = 有 highlight.mjs 就用 js，缺了才回落 ps；js 不需要 PowerShell
    engine: pick(c.engine, 'auto'),
    // Electron 的 process.execPath 是 electron.exe，spawn 时靠 ELECTRON_RUN_AS_NODE 当 node 用
    nodePath: pick(c.nodePath, process.execPath),
    ocrExe: pick(c.ocrExe, firstExisting(
      [path.join(HERE, 'bin', 'kfocr.exe'), path.join(REPO, 'kfocr', 'target', 'release', 'kfocr.exe')],
      path.join(REPO, 'kfocr', 'target', 'release', 'kfocr.exe')
    )),
    modelsDir: pick(c.modelsDir, process.env.TACK_OCR_MODELS || firstExisting(
      [path.join(HERE, 'models')],
      ''
    )),
    pwshPath: pick(c.pwshPath, 'pwsh'),
    scanFps: positive(c.scanFps, 2),
    chunkSize: positive(c.chunkSize, 60),
    waitSeconds: positive(c.waitSeconds, 45),
    localId: pick(c.localId, 'auto'),
    // 可被界面覆盖的默认值：空 = 每次用回放目录里最新的一条
    sourcePath: pick(c.sourcePath, ''),
    pre: numberInRange(c.pre, 0, 10, 3.5),
    post: numberInRange(c.post, 0, 10, 1.5),
    keepWork: c.keepWork === true
  }
}

/** 读配置里的数字并夹到 [min, max]；非法值用默认。 */
function numberInRange (value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// ── 界面可改的设置 ────────────────────────────────────────────────
// 存在用户目录下的 JSON，而不是回写 profile 的 cordis.patch.yml：
// 插件是 bundle 插入行，配置编辑器只编辑 profile 自己的 Include，改不到它；
// 这里做一层「设置文件覆盖配置默认值」，保存即时生效，不用重启插件。
const SETTINGS_FILE = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.config'),
  'AutoReel',
  'settings.json'
)

function loadStoredSettings () {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveStoredSettings (value) {
  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(value, null, 2), 'utf8')
}

/** 只接受已知字段，避免设置文件里塞进任意东西。 */
function sanitizeSettings (patch) {
  const out = {}
  if (typeof patch.replaysDir === 'string') out.replaysDir = patch.replaysDir.trim()
  if (typeof patch.sourcePath === 'string') out.sourcePath = patch.sourcePath.trim()
  if (typeof patch.outputDir === 'string') out.outputDir = patch.outputDir.trim()
  if (patch.pre !== undefined) out.pre = Number(patch.pre)
  if (patch.post !== undefined) out.post = Number(patch.post)
  return out
}

/** 校验并补全候选设置；失败抛出面向用户的错误。 */
function validateSettings (next) {
  const pre = Number(next.pre)
  const post = Number(next.post)
  if (!Number.isFinite(pre) || pre < 0 || pre > 10) throw new Error('击杀前秒数需要 0–10')
  if (!Number.isFinite(post) || post < 0 || post > 10) throw new Error('击杀后秒数需要 0–10')
  if (typeof next.replaysDir !== 'string' || !next.replaysDir.trim()) throw new Error('回放目录不能为空')
  if (typeof next.outputDir !== 'string' || !next.outputDir.trim()) throw new Error('输出目录不能为空')
  if (!path.isAbsolute(next.replaysDir)) throw new Error('回放目录需要绝对路径')
  if (!existsSync(next.replaysDir)) throw new Error(`回放目录不存在: ${next.replaysDir}`)
  if (!path.isAbsolute(next.outputDir)) throw new Error('输出目录需要绝对路径')
  mkdirSync(next.outputDir, { recursive: true })
  if (next.sourcePath) {
    if (!path.isAbsolute(next.sourcePath)) throw new Error('回放文件需要绝对路径')
    if (!existsSync(next.sourcePath)) throw new Error(`回放文件不存在: ${next.sourcePath}`)
    if (!statSync(next.sourcePath).isFile()) throw new Error(`回放文件不是文件: ${next.sourcePath}`)
  }
  return { ...next, pre, post }
}

function probe (command, args, env) {
  try {
    execFileSync(command, args, {
      timeout: 5000,
      windowsHide: true,
      stdio: 'ignore',
      ...(env ? { env: { ...process.env, ...env } } : {})
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.code === 'ENOENT' ? '未找到该命令' : String(error.message).split('\n')[0] }
  }
}

/** 实际使用哪个引擎：显式配置优先，auto 看 JS 引擎文件在不在。 */
function resolveEngine (cfg) {
  if (cfg.engine === 'js' || cfg.engine === 'ps') return cfg.engine
  return existsSync(cfg.engineScript) ? 'js' : 'ps'
}

async function probeFile (file) {
  try {
    const info = await stat(file)
    return info.isFile() ? { ok: true } : { ok: false, error: '不是文件' }
  } catch {
    return { ok: false, error: '不存在' }
  }
}

async function probeDir (dir) {
  try {
    const info = await stat(dir)
    return info.isDirectory() ? { ok: true } : { ok: false, error: '不是目录' }
  } catch {
    return { ok: false, error: '不存在' }
  }
}

/** 媒体 URL：按素材名寻址，和 out/<素材名>/highlight_reel.mp4 一一对应。 */
function mediaUrlFor (stem) {
  return `${MEDIA_PREFIX}${encodeURIComponent(stem)}/${REEL_NAME}`
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function apply (ctx, config) {
  const cfg = resolveConfig(config)
  // 设置文件覆盖配置默认值；读坏了就退回配置，不影响插件启动
  const persisted = sanitizeSettings(loadStoredSettings())
  const settings = {
    replaysDir: pick(persisted.replaysDir, cfg.replaysDir),
    sourcePath: typeof persisted.sourcePath === 'string' ? persisted.sourcePath : cfg.sourcePath,
    outputDir: pick(persisted.outputDir, cfg.outputDir),
    pre: numberInRange(persisted.pre, 0, 10, cfg.pre),
    post: numberInRange(persisted.post, 0, 10, cfg.post)
  }

  /** jobId -> 运行记录。作业结算后仍保留，供卡片/接口读取结果。 */
  const runs = new Map()
  let latestId = null
  let activeId = null
  let localSeq = 0

  function remember (rec) {
    runs.set(rec.id, rec)
    latestId = rec.id
    if (runs.size > 30) {
      for (const key of runs.keys()) {
        if (runs.size <= 20) break
        if (key === latestId || key === activeId) continue
        runs.delete(key)
      }
    }
  }

  function applyEvent (rec, event, job) {
    switch (event.ev) {
      case 'stage':
        rec.stage = event.name ?? rec.stage
        rec.progress = event.text ?? rec.progress
        break
      case 'media':
        // 引擎按 ffprobe 读到的分辨率算出的 ROI（默认按高度相对 1440p 等比缩放）
        rec.media = {
          width: event.width,
          height: event.height,
          fps: event.fps,
          scale: event.scale,
          profile: event.profile,
          roi: event.roi
        }
        break
      case 'progress':
        if (typeof event.pct === 'number') rec.pct = event.pct
        rec.progress = event.text ?? rec.progress
        break
      case 'localId':
        rec.localId = event.id ?? rec.localId
        break
      case 'kills':
        rec.kills = Array.isArray(event.kills) ? event.kills : []
        break
      case 'segments':
        rec.segments = Array.isArray(event.segments) ? event.segments : []
        break
      case 'result':
        rec.status = 'completed'
        rec.pct = 100
        rec.output = typeof event.output === 'string' ? event.output : rec.output
        rec.duration = event.duration ?? rec.duration
        rec.width = event.width ?? rec.width
        rec.height = event.height ?? rec.height
        rec.sizeMb = event.sizeMb ?? rec.sizeMb
        rec.elapsed = event.elapsed ?? rec.elapsed
        rec.localId = event.localId ?? rec.localId
        rec.progress = '完成'
        break
      default:
        return
    }
    if (job && typeof job.updateProgress === 'function') {
      const pct = Math.round(rec.pct ?? 0)
      job.updateProgress(`${pct}%${rec.progress ? ` ${rec.progress}` : ''}`)
    }
  }

  /** 真正起进程；job 为 null 时是"没有作业服务"的降级路径。 */
  function launch (request, job) {
    const stem = stemOf(request.source)
    const outDir = path.join(request.outputDir || settings.outputDir, stem)
    const pre = numberInRange(request.pre, 0, 10, settings.pre)
    const post = numberInRange(request.post, 0, 10, settings.post)
    const initialEngine = resolveEngine(cfg)
    if (initialEngine === 'js' && !existsSync(cfg.engineScript)) {
      throw new Error(`JS 引擎不存在: ${cfg.engineScript}（改 config.engine: ps，或修正 engineScript）`)
    }
    const rec = {
      id: job ? job.id : `local-${++localSeq}`,
      label: `auto-reel ${path.basename(request.source)}`,
      source: request.source,
      stem,
      outDir,
      engine: initialEngine,
      pre,
      post,
      status: 'running',
      stage: null,
      pct: 0,
      progress: '启动中',
      localId: request.localId,
      media: null,
      kills: [],
      segments: [],
      output: null,
      error: null,
      canceled: false,
      startedAt: Date.now(),
      finishedAt: null,
      duration: null,
      width: null,
      height: null,
      sizeMb: null,
      elapsed: null,
      log: []
    }
    activeId = rec.id
    remember(rec)

    /** 起一次引擎进程；engine 决定跑 highlight.mjs 还是 highlight.ps1。 */
    const startPipeline = (engine) => runPipeline({
      engine,
      nodePath: cfg.nodePath,
      pwshPath: cfg.pwshPath,
      scriptPath: engine === 'ps' ? cfg.scriptPath : cfg.engineScript,
      source: request.source,
      outDir,
      scanFps: cfg.scanFps,
      chunkSize: cfg.chunkSize,
      pre,
      post,
      localId: request.localId,
      roi: request.roi,
      ocrExe: cfg.ocrExe,
      // kfocr 只认 --models 参数或 TACK_OCR_MODELS 环境变量；两个引擎都靠这里注入
      env: cfg.modelsDir ? { ...process.env, TACK_OCR_MODELS: cfg.modelsDir } : undefined,
      keepWork: cfg.keepWork
    }, {
      onEvent: (event) => applyEvent(rec, event, job),
      onLog: (line) => {
        rec.log.push(line)
        if (rec.log.length > 200) rec.log.shift()
        if (job && typeof job.append === 'function') job.append(`${line}\n`, { channel: 'log' })
      }
    })

    let pipeline = startPipeline(initialEngine)

    /** 进程结束后落账；两种引擎走同一套状态机。 */
    const settle = ({ code, error }) => {
      rec.finishedAt = Date.now()
      if (rec.status !== 'completed') {
        rec.status = rec.canceled ? 'killed' : 'failed'
        const tail = rec.log.filter((line) => line.trim()).slice(-1)[0]
        rec.error = error || `引擎退出码 ${code}${tail ? `：${tail}` : ''}`
        rec.progress = rec.error
      }
      if (activeId === rec.id) activeId = null
      if (rec.status === 'completed' && rec.output) {
        const tail = rec.log.filter((line) => line.trim())
        rec.elapsed = rec.elapsed ?? Math.round((rec.finishedAt - rec.startedAt) / 100) / 10
        if (tail.length > 0) rec.log = tail.slice(-80)
      }
      return {
        status: rec.status === 'completed' ? 'completed' : (rec.status === 'killed' ? 'killed' : 'failed'),
        ...(rec.error ? { detail: rec.error } : {}),
        result: JSON.stringify(publicRun(rec))
      }
    }

    const finished = pipeline.done.then(async (first) => {
      // auto：JS 引擎早期就失败（一条击杀都还没产出）时，用 PS 引擎重试一次。
      // 已经出过击杀说明判定跑通了，这时再回落只会重跑一遍，不如把错误暴露出来。
      const canFallback = cfg.engine === 'auto' &&
        initialEngine === 'js' &&
        !rec.canceled &&
        rec.kills.length === 0 &&
        first.code !== 0
      if (!canFallback) return settle(first)

      rec.log.push('[plugin] JS 引擎失败，回落到 PowerShell 引擎重试')
      rec.engine = 'ps'
      rec.stage = null
      rec.pct = 0
      rec.progress = 'JS 引擎失败，回落到 PS 引擎'
      rec.localId = request.localId
      rec.media = null
      rec.error = null
      pipeline = startPipeline('ps')
      return settle(await pipeline.done)
    })

    return { rec, get pipeline () { return pipeline }, finished }
  }

  /** 起一次剪辑；重复请求会被 activeId 拦住（OCR 吃满 CPU，串行更稳）。 */
  function startRun (request) {
    if (activeId) {
      const active = runs.get(activeId)
      throw new Error(`已有剪辑任务在跑（${activeId}：${active?.progress ?? '准备中'}），等它结束或先 job_kill。`)
    }
    if (ctx.jobs && request.sessionId) {
      let started = null
      const id = ctx.jobs.start({
        kind: 'auto-reel',
        label: `auto-reel ${path.basename(request.source)}`,
        owner: request.sessionId,
        ...(request.toolCall ? { toolCall: request.toolCall } : {}),
        run (job) {
          started = launch(request, job)
          return {
            cancel: () => {
              started.rec.canceled = true
              started.pipeline.cancel()
            },
            done: started.finished
          }
        }
      })
      if (!started) throw new Error('作业启动失败')
      return { id, rec: started.rec, finished: started.finished }
    }
    const started = launch(request, null)
    return { id: null, rec: started.rec, finished: started.finished }
  }

  function publicRun (rec) {
    return {
      id: rec.id,
      label: rec.label,
      source: rec.source,
      stem: rec.stem,
      engine: rec.engine,
      pre: rec.pre,
      post: rec.post,
      status: rec.status,
      stage: rec.stage,
      pct: rec.pct,
      progress: rec.progress,
      localId: rec.localId,
      media: rec.media,
      kills: rec.kills,
      segments: rec.segments,
      output: rec.output,
      // run 维度的媒体地址：面板可能用未保存的 outputDir 起任务，按素材名拼会指错目录
      mediaUrl: rec.output ? `${MEDIA_PREFIX}run/${encodeURIComponent(rec.id)}/${REEL_NAME}` : null,
      error: rec.error,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      duration: rec.duration,
      width: rec.width,
      height: rec.height,
      sizeMb: rec.sizeMb,
      elapsed: rec.elapsed,
      log: rec.log.slice(-12)
    }
  }

  async function resolveSource (value) {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (raw && raw !== 'latest') {
      const abs = path.isAbsolute(raw) ? raw : path.resolve(raw)
      const info = await stat(abs).catch(() => null)
      if (!info || !info.isFile()) throw new Error(`源录像不存在: ${raw}`)
      return abs
    }
    // 面板里存了「指定回放」就用它；没有或用 latest 时退回目录里最新的一条
    if (settings.sourcePath && existsSync(settings.sourcePath)) {
      const info = await stat(settings.sourcePath).catch(() => null)
      if (info && info.isFile()) return settings.sourcePath
    }
    const latest = await latestReplay(settings.replaysDir)
    return latest.path
  }

  /** 工具结果：前面是一段 key: value，卡片照它渲染，模型读下面的人话。 */
  function formatResult (rec) {
    const kills = rec.kills ?? []
    const segments = rec.segments ?? []
    const lines = []
    lines.push(`AutoReel — ${rec.stem}`)
    lines.push(`job: ${rec.id}`)
    lines.push(`engine: ${rec.engine ?? '?'}`)
    lines.push(`pre/post: ${rec.pre ?? '?'}s / ${rec.post ?? '?'}s`)
    lines.push(`status: ${rec.status}`)
    lines.push(`progress: ${Math.round(rec.pct ?? 0)}% ${rec.progress ?? ''}`.trimEnd())
    lines.push(`source: ${rec.source}`)
    if (rec.output) lines.push(`output: ${rec.output}`)
    if (rec.media) {
      lines.push(`media: ${rec.media.width}x${rec.media.height} @${rec.media.fps}fps  profile=${rec.media.profile}  scale=${rec.media.scale}`)
    }
    lines.push(`localId: ${rec.localId}`)
    if (rec.status === 'completed') {
      lines.push(`kills: ${kills.length}  segments: ${segments.length}  duration: ${rec.duration ?? '?'}s  sizeMb: ${rec.sizeMb ?? '?'}  elapsed: ${rec.elapsed ?? '?'}s`)
    }
    if (rec.error) lines.push(`error: ${rec.error}`)
    if (rec.status !== 'completed') {
      lines.push('')
      lines.push('任务还在后台跑：用 job_output 收集结果（job id 见上），或 job_kill 取消。')
    }
    if (kills.length > 0) {
      lines.push('')
      lines.push('—— 击杀明细 ——')
      for (const kill of kills.slice(0, 30)) {
        lines.push(`${String(kill.t).padStart(6)}s  ${kill.text}${kill.slot !== undefined ? `  (slot ${kill.slot})` : ''}`)
      }
      if (kills.length > 30) lines.push(`… 另有 ${kills.length - 30} 条`)
    }
    if (segments.length > 0) {
      lines.push('')
      lines.push('—— 剪辑分段 ——')
      for (const seg of segments) {
        lines.push(`${String(seg.start).padStart(7)}s → ${String(seg.end).padStart(7)}s  ${seg.text}`)
      }
    }
    return lines.join('\n')
  }

  // ── 工具 ────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'auto_reel',
    description: [
      '从 NVIDIA 即时回放里按击杀信息栏 OCR 自动剪出击杀集锦（Valorant）。',
      '抽帧 → OCR → 重建击杀事件 → 切片 → 拼接，产出一个 highlight_reel.mp4。',
      '本机玩家 ID 默认自动识别；识别不出来会报错，此时用 localId 显式指定。',
      '耗时长（120s 素材约 1 分钟），默认阻塞到 45s，没跑完就返回作业 id，用 job_output 继续收。'
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: '回放文件路径；省略或写 latest 就用回放目录里最新的一条 .DVR。'
        },
        localId: {
          type: 'string',
          description: '本机玩家 ID；默认 auto（从行首黄色头像框推断）。'
        },
        roi: {
          type: 'string',
          description: '击杀条 ROI，格式 "x,w,h,y1,y2,y3"（源视频像素），默认 auto：按视频分辨率相对 1440p 等比缩放、横向贴右边缘。只有自动 ROI 识别不到击杀时才需要显式指定。'
        },
        waitSeconds: {
          type: 'number',
          description: '阻塞等待上限秒数，默认 45；超时返回仍在跑的作业 id。'
        }
      },
      required: []
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }]
    },
    async execute (args, exec) {
      const a = args && typeof args === 'object' ? args : {}
      const source = await resolveSource(a.source)
      const localId = typeof a.localId === 'string' && a.localId.trim() ? a.localId.trim() : cfg.localId
      const roi = typeof a.roi === 'string' && a.roi.trim() && a.roi.trim() !== 'auto' ? a.roi.trim() : 'auto'
      const waitSeconds = clamp(positive(a.waitSeconds, cfg.waitSeconds), 5, 600)
      const sessionId = exec?.agent?.session?.id
      const toolCall = exec?.callId
        ? { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId }
        : undefined

      const started = startRun({ source, localId, roi, sessionId, toolCall })
      if (started.id && ctx.jobs && sessionId) {
        try {
          await ctx.jobs.wait(started.id, waitSeconds * 1000, sessionId, exec?.signal)
        } catch {
          // 取消/超时：把当前进度交回去，作业本身继续跑
        }
      } else {
        await started.finished
      }
      return formatResult(started.rec)
    }
  }))

  // ── 路由 ────────────────────────────────────────────────────
  const route = (kind, routePath, handler) => {
    ctx.effect(() => ctx.webServer.register({ kind, path: routePath, handler }))
  }

  const healthPayload = async () => {
    const engine = resolveEngine(cfg)
    const checks = {
      ffmpeg: probe('ffmpeg', ['-version']),
      script: await probeFile(engine === 'ps' ? cfg.scriptPath : cfg.engineScript),
      ocr: await probeFile(cfg.ocrExe)
    }
    if (engine === 'js') {
      // Electron 的 execPath 不是 node.exe，探测时同样要按 node 跑
      const nodeEnv = /^node(\.exe)?$/i.test(path.basename(cfg.nodePath)) ? undefined : { ELECTRON_RUN_AS_NODE: '1' }
      checks.node = probe(cfg.nodePath, ['--version'], nodeEnv)
      checks.pwsh = { ok: true, note: 'engine=js，未使用（auto 回落时才需要）' }
    } else {
      checks.node = { ok: true, note: 'engine=ps，未使用' }
      checks.pwsh = probe(cfg.pwshPath, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])
    }
    const modelsPath = cfg.modelsDir
    checks.models = modelsPath
      ? await probeFile(path.join(modelsPath, 'rec.rten'))
      : { ok: false, error: '未配置 modelsDir，也没有找到 TACK_OCR_MODELS' }
    checks.replaysDir = await probeDir(settings.replaysDir)
    // 面板的「浏览…」能不能用，取决于宿主挂的是 native 还是 browse
    try {
      const picker = ctx.get('directoryPicker')
      const capability = picker && typeof picker.capability === 'function' ? picker.capability() : null
      checks.directoryPicker = capability
        ? { ok: true, kind: capability.kind }
        : { ok: false, error: '宿主没有目录选择服务' }
    } catch (error) {
      checks.directoryPicker = { ok: false, error: String(error?.message ?? error) }
    }
    const ok = Object.values(checks).every((check) => check.ok)
    return {
      ok,
      plugin: 'auto-reel',
      version: VERSION,
      engine: engine === 'js' ? 'node highlight.mjs --machine' : 'pwsh highlight.ps1 -Machine',
      engineMode: cfg.engine,
      settings: { ...settings },
      config: {
        replaysDir: cfg.replaysDir,
        outputDir: cfg.outputDir,
        scanFps: cfg.scanFps,
        chunkSize: cfg.chunkSize,
        engine: cfg.engine,
        pre: cfg.pre,
        post: cfg.post,
        sourcePath: cfg.sourcePath
      },
      checks
    }
  }

  route('exact', '/autoreel/api/health', async (req, res) => {
    try {
      sendJson(res, 200, await healthPayload())
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // 诊断：客户端模块有没有被编进启动图（页面刷新后能不能拿到我们的 client.js）。
  route('exact', '/autoreel/api/client-graph', (req, res) => {
    try {
      const graph = ctx.clientModules.graph()
      const entries = Array.isArray(graph?.entries) ? graph.entries : []
      const ours = entries.filter((entry) => entry && entry.id === '@local/auto-reel')
      sendJson(res, 200, {
        rev: graph?.rev ?? null,
        count: entries.length,
        ours,
        entryKeys: entries.length > 0 ? Object.keys(entries[0]) : []
      })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  route('exact', '/autoreel/api/replays', async (req, res) => {
    try {
      // 面板改「回放目录」时先按新目录列，不必保存；给的必须是绝对路径
      const asked = new URL(req.url, 'http://localhost').searchParams.get('dir')
      if (asked !== null && !path.isAbsolute(asked)) {
        sendJson(res, 400, { error: '回放目录需要绝对路径', dir: asked, items: [] })
        return
      }
      const dir = asked ?? settings.replaysDir
      if (!existsSync(dir)) { sendJson(res, 400, { error: `回放目录不存在: ${dir}`, dir, items: [] }); return }
      const items = await listReplays(dir)
      sendJson(res, 200, { dir, items })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  // 面板读设置
  route('exact', '/autoreel/api/settings', async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, settings: { ...settings }, defaults: { ...cfg }, file: SETTINGS_FILE })
      return
    }
    if (req.method !== 'POST') { sendText(res, 405, 'method not allowed'); return }
    try {
      const body = await readJsonBody(req)
      const patch = sanitizeSettings(body && typeof body === 'object' ? body : {})
      const next = validateSettings({
        replaysDir: patch.replaysDir !== undefined ? patch.replaysDir : settings.replaysDir,
        sourcePath: patch.sourcePath !== undefined ? patch.sourcePath : settings.sourcePath,
        outputDir: patch.outputDir !== undefined ? patch.outputDir : settings.outputDir,
        pre: patch.pre !== undefined ? patch.pre : settings.pre,
        post: patch.post !== undefined ? patch.post : settings.post
      })
      saveStoredSettings(next)
      Object.assign(settings, next)
      sendJson(res, 200, { ok: true, settings: { ...settings } })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // 面板「浏览…」：调用 DSH 自己的目录选择服务（本机桌面会弹系统对话框）
  route('exact', '/autoreel/api/pick-dir', async (req, res) => {
    if (req.method !== 'POST') { sendText(res, 405, 'method not allowed'); return }
    const picker = ctx.get('directoryPicker')
    if (!picker || typeof picker.capability !== 'function') {
      sendJson(res, 400, { ok: false, error: '当前环境没有目录选择服务，请直接输入路径' })
      return
    }
    let capability
    try {
      capability = picker.capability()
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      return
    }
    if (!capability || capability.kind !== 'native' || typeof capability.pick !== 'function') {
      sendJson(res, 400, { ok: false, error: '当前环境不是本机桌面，无法弹出系统目录对话框，请直接输入路径' })
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000)
    if (typeof res.on === 'function') res.on('close', () => controller.abort())
    try {
      const picked = await capability.pick(controller.signal)
      sendJson(res, 200, { ok: true, path: picked ?? null })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    } finally {
      clearTimeout(timer)
    }
  })

  // 面板「剪这条」：和工具走同一个 launch，只是没有会话作业，返回本地 run id 供轮询
  route('exact', '/autoreel/api/cut', async (req, res) => {
    if (req.method !== 'POST') { sendText(res, 405, 'method not allowed'); return }
    try {
      const body = await readJsonBody(req)
      const asked = body && typeof body === 'object' ? body : {}
      // 面板里的「最新一条」必须按面板当前的目录解析，不能沿用已保存的 sourcePath
      const replayDir = pick(asked.replaysDir, settings.replaysDir)
      if (!path.isAbsolute(replayDir)) throw new Error('回放目录需要绝对路径')
      if (!existsSync(replayDir)) throw new Error(`回放目录不存在: ${replayDir}`)
      const source = asked.source ? await resolveSource(asked.source) : (await latestReplay(replayDir)).path
      const pre = numberInRange(asked.pre, 0, 10, settings.pre)
      const post = numberInRange(asked.post, 0, 10, settings.post)
      const outputDir = pick(asked.outputDir, settings.outputDir)
      if (!path.isAbsolute(outputDir)) throw new Error('输出目录需要绝对路径')
      mkdirSync(outputDir, { recursive: true })
      const started = startRun({ source, localId: cfg.localId, roi: asked.roi, pre, post, outputDir })
      sendJson(res, 202, { ok: true, id: started.id ?? started.rec.id, run: publicRun(started.rec) })
    } catch (error) {
      const busy = /已有剪辑任务在跑/.test(String(error?.message ?? ''))
      sendJson(res, busy ? 409 : 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('exact', '/autoreel/api/runs/latest', (req, res) => {
    const rec = latestId ? runs.get(latestId) : null
    sendJson(res, 200, rec ? publicRun(rec) : { id: null })
  })

  route('prefix', RUNS_ROUTE, (req, res) => {
    const id = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(RUNS_ROUTE.length).replace(/^\/+/, ''))
    const rec = runs.get(id)
    if (!rec) { sendJson(res, 404, { error: 'job not found' }); return }
    sendJson(res, 200, publicRun(rec))
  })

  route('exact', '/autoreel/api/library', async (req, res) => {
    try {
      const items = (await listReels(settings.outputDir)).map((reel) => ({ ...reel, mediaUrl: mediaUrlFor(reel.stem) }))
      sendJson(res, 200, { dir: settings.outputDir, items })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  route('exact', '/autoreel/api/reveal', async (req, res) => {
    if (req.method !== 'POST') { sendText(res, 405, 'method not allowed'); return }
    try {
      const body = await readJsonBody(req)
      const stem = typeof body.stem === 'string' ? body.stem : ''
      const runId = typeof body.id === 'string' ? body.id : ''
      const rec = runId ? runs.get(runId) : null
      // 有 run 记录时选中它的成片文件（explorer /select 会打开所在目录并选中）
      const target = rec && rec.output
        ? rec.output
        : (stem ? path.join(settings.outputDir, stem, REEL_NAME) : settings.outputDir)
      if (process.platform !== 'win32') {
        spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
        sendJson(res, 200, { ok: true, target, code: 0 })
        return
      }
      // explorer 的 /select 要求「/select,」和路径分开传：拼成一个参数时 Node 会把整串加引号，
      // explorer 解析不出来，就什么都不弹。这里等它退出，把 exit code 一起回给卡片。
      const result = await new Promise((resolve) => {
        let settled = false
        const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
        const child = execFile('explorer.exe', ['/select,', target], { windowsHide: true }, (error, stdout, stderr) => {
          // explorer 成功打开时也常常返回 1，所以只有 spawn 层失败才算错
          const spawnFailed = error !== null && typeof error.code === 'string'
          finish({
            ok: !spawnFailed,
            code: typeof error?.code === 'number' ? error.code : 0,
            ...(spawnFailed ? { error: error.message } : {}),
            ...(String(stderr ?? '').trim() ? { stderr: String(stderr).trim() } : {})
          })
        })
        child.on('error', (error) => finish({ ok: false, code: -1, error: error.message }))
        child.on('spawn', () => setTimeout(() => finish({ ok: true, code: 0 }), 1200))
      })
      sendJson(res, 200, { ...result, target })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('prefix', MEDIA_ROUTE, async (req, res) => {
    let rel
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(MEDIA_ROUTE.length).replace(/^\/+/, ''))
    } catch {
      sendText(res, 400, 'bad url')
      return
    }
    // 面板发起的一次 run：输出目录可能还没保存，按 run 记录直接定位到它的成片
    const runMedia = /^run\/([^/]+)\/highlight_reel\.mp4$/.exec(rel)
    if (runMedia) {
      const rec = runs.get(decodeURIComponent(runMedia[1]))
      if (!rec || !rec.output) { sendText(res, 404, 'not found'); return }
      await serveFile(req, res, path.join(rec.outDir, REEL_NAME))
      return
    }
    const root = path.resolve(settings.outputDir)
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) { sendText(res, 403, 'forbidden'); return }
    if (path.extname(abs).toLowerCase() !== '.mp4') { sendText(res, 403, 'forbidden'); return }
    await serveFile(req, res, abs)
  })
}
