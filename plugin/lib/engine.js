/**
 * 跑一次 AutoReel 管线。
 *
 * 两个引擎输出同一份 `HC <json>` 事件流（见 scripts/highlight.mjs 的 --machine
 * 与 scripts/highlight.ps1 的 -Machine），所以上层只认事件、不关心是谁跑的：
 *   js —— `<node> highlight.mjs`（默认，不需要 PowerShell）
 *   ps —— `pwsh highlight.ps1 -Machine`（回落路径）
 *
 * 这里只负责起进程、切行、回调；事件含义由 index.js 解释。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * 把同一次请求翻译成引擎命令行（纯函数，便于单测）。
 *
 * @param {'js'|'ps'} engine
 * @param {object} options
 * @returns {{command: string, args: string[]}}
 */
export function buildCommand (engine, options) {
  const args = []
  if (engine === 'ps') {
    args.push('-NoProfile', '-File', options.scriptPath, '-Machine')
    args.push('-Source', options.source)
    args.push('-Out', options.outDir)
    args.push('-ScanFps', String(options.scanFps))
    args.push('-ChunkSize', String(options.chunkSize))
    if (options.pre !== undefined) args.push('-Pre', String(options.pre))
    if (options.post !== undefined) args.push('-Post', String(options.post))
    if (options.localId && options.localId !== 'auto') args.push('-LocalId', options.localId)
    if (options.roi && options.roi !== 'auto') args.push('-Roi', options.roi)
    if (options.ocrExe) args.push('-OcrExe', options.ocrExe)
    if (options.workDir) args.push('-Work', options.workDir)
    if (options.keepWork) args.push('-KeepWork')
    return { command: options.pwshPath || 'pwsh', args }
  }

  args.push(options.scriptPath)
  args.push('--source', options.source)
  args.push('--machine', '--out', options.outDir)
  args.push('--scan-fps', String(options.scanFps), '--chunk-size', String(options.chunkSize))
  if (options.pre !== undefined) args.push('--pre', String(options.pre))
  if (options.post !== undefined) args.push('--post', String(options.post))
  if (options.localId && options.localId !== 'auto') args.push('--local-id', options.localId)
  if (options.roi && options.roi !== 'auto') args.push('--roi', options.roi)
  if (options.ocrExe) args.push('--ocr', options.ocrExe)
  if (options.workDir) args.push('--work', options.workDir)
  if (options.keepWork) args.push('--keep-work')
  // 速度开关只对 JS 引擎有效（highlight.ps1 没有这些参数），且默认档一律不传，
  // 这样参数里出现什么就代表用户/配置真的改了什么。
  if (options.extract && options.extract !== 'full') args.push('--extract', options.extract)
  if (options.encoder && options.encoder !== 'libx264') args.push('--encoder', options.encoder)
  if (options.fastCopy) args.push('--fast-copy')
  if (options.cutJobs > 1) args.push('--cut-jobs', String(options.cutJobs))
  if (options.ocrJobs > 0) args.push('--ocr-jobs', String(options.ocrJobs))
  return { command: options.nodePath || process.execPath, args }
}

function childEnv (engine, options, command) {
  const env = { ...process.env, ...(options.env || {}) }
  // Electron 的 process.execPath 是 electron.exe：带上这个变量才按 Node 跑脚本。
  // 用户显式配成 node.exe 时不需要（普通 node 会忽略这个变量，这里只是少设一个）。
  if (engine !== 'ps' && !/^node(\.exe)?$/i.test(path.basename(command))) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/**
 * @param {object} options
 * @param {'js'|'ps'} [options.engine]
 * @param {string} options.scriptPath      js=highlight.mjs / ps=highlight.ps1
 * @param {string} [options.nodePath]      js 引擎的 node（默认 process.execPath）
 * @param {string} [options.pwshPath]      ps 引擎的 pwsh
 * @param {string} options.source
 * @param {string} options.outDir
 * @param {number} options.scanFps
 * @param {number} options.chunkSize
 * @param {string} [options.localId]       'auto' 或显式 ID
 * @param {string} [options.roi]           'auto' 或 "x,w,h,y1,y2,y3"
 * @param {string} [options.ocrExe]
 * @param {string} [options.workDir]
 * @param {boolean} [options.keepWork]
 * @param {'full'|'keyframe'} [options.extract]
 * @param {'libx264'|'nvenc'|'auto'} [options.encoder]
 * @param {boolean} [options.fastCopy]
 * @param {number} [options.cutJobs]
 * @param {number} [options.ocrJobs]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(event: object) => void} handlers.onEvent
 * @param {(line: string) => void} handlers.onLog
 */
export function runPipeline (options, handlers) {
  const engine = options.engine === 'ps' ? 'ps' : 'js'
  const { command, args } = buildCommand(engine, options)

  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(engine, options, command)
  })

  let stdoutBuf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line) continue
      if (!line.startsWith('HC ')) { handlers.onLog(line); continue }
      try {
        handlers.onEvent(JSON.parse(line.slice(3)))
      } catch (error) {
        handlers.onLog(`[plugin] 无法解析事件行: ${line}`)
      }
    }
  })

  let stderrBuf = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk
    let nl
    while ((nl = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
      stderrBuf = stderrBuf.slice(nl + 1)
      if (line.trim()) handlers.onLog(line)
    }
  })

  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: -1, error: error.message }))
    child.on('close', (code) => {
      if (stderrBuf.trim()) handlers.onLog(stderrBuf.trim())
      resolve({ code, error: undefined })
    })
  })

  // Windows 上 kill() 只杀直接子进程，ffmpeg / kfocr 会变成孤儿继续吃 CPU。
  // taskkill /T 连整棵进程树一起收掉（node 版同样会带一串 ffmpeg/kfocr 子进程）。
  const cancel = () => {
    if (!child.pid) return
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      try { child.kill('SIGTERM') } catch {}
    }
  }

  return { child, done, cancel }
}
