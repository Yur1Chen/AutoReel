/**
 * scripts/test-plugin.mjs —— 插件 Host 半的引擎适配自测。
 *
 * 1) buildCommand 参数映射（纯函数，随时可跑）；
 * 2) --spawn：真的用 runPipeline 跑一条短素材，验证 js 引擎的 spawn / 事件解析 / 取消链路。
 *    注意：DSH 沙箱禁止子进程管道，第 2 项要在非沙箱环境（或 danger-full-access）下跑。
 *
 * 用法：
 *   node scripts/test-plugin.mjs            # 只测参数映射
 *   node scripts/test-plugin.mjs --spawn    # 额外跑一次真素材
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildCommand, runPipeline } from '../plugin/lib/engine.js'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(SCRIPTS)
const REPLAY = path.join(process.env.USERPROFILE ?? '', 'Videos', 'VALORANT', 'Valorant 2026.11.11 - 23.18.37.03.DVR.mp4')

const base = {
  source: 'C:\\v\\a.mp4',
  outDir: 'D:\\out\\a',
  scanFps: 2,
  chunkSize: 60,
  pre: 3.5,
  post: 1.5
}

const jsFull = buildCommand('js', {
  ...base,
  scriptPath: 'X:\\highlight.mjs',
  nodePath: 'node.exe',
  localId: '乐邦詹士',
  roi: '1,2,3,4,5,6',
  ocrExe: 'kfocr.exe',
  workDir: 'W:\\work',
  keepWork: true
})
assert.equal(jsFull.command, 'node.exe')
assert.deepEqual(jsFull.args, [
  'X:\\highlight.mjs',
  '--source', 'C:\\v\\a.mp4',
  '--machine', '--out', 'D:\\out\\a',
  '--scan-fps', '2', '--chunk-size', '60',
  '--pre', '3.5', '--post', '1.5',
  '--local-id', '乐邦詹士',
  '--roi', '1,2,3,4,5,6',
  '--ocr', 'kfocr.exe',
  '--work', 'W:\\work',
  '--keep-work'
])

const jsAuto = buildCommand('js', {
  ...base,
  scriptPath: 'X:\\highlight.mjs',
  nodePath: 'node.exe',
  localId: 'auto',
  roi: 'auto'
})
assert.deepEqual(jsAuto.args, [
  'X:\\highlight.mjs',
  '--source', 'C:\\v\\a.mp4',
  '--machine', '--out', 'D:\\out\\a',
  '--scan-fps', '2', '--chunk-size', '60',
  '--pre', '3.5', '--post', '1.5'
])

const psFull = buildCommand('ps', {
  ...base,
  scriptPath: 'X:\\highlight.ps1',
  pwshPath: 'pwsh.exe',
  localId: '乐邦詹士',
  roi: '1,2,3,4,5,6',
  ocrExe: 'kfocr.exe',
  workDir: 'W:\\work'
})
assert.equal(psFull.command, 'pwsh.exe')
assert.deepEqual(psFull.args, [
  '-NoProfile', '-File', 'X:\\highlight.ps1', '-Machine',
  '-Source', 'C:\\v\\a.mp4',
  '-Out', 'D:\\out\\a',
  '-ScanFps', '2', '-ChunkSize', '60',
  '-Pre', '3.5', '-Post', '1.5',
  '-LocalId', '乐邦詹士',
  '-Roi', '1,2,3,4,5,6',
  '-OcrExe', 'kfocr.exe',
  '-Work', 'W:\\work'
])

console.log('[PASS] buildCommand：js 显式参数 / js auto / ps 显式参数 三组映射')

if (process.argv.includes('--spawn')) {
  if (!(await fs.access(REPLAY).then(() => true, () => false))) {
    console.log(`[SKIP] --spawn：素材不存在 ${REPLAY}`)
    process.exit(0)
  }
  const outDir = path.join(ROOT, 'out', '_plugin_test')
  const events = []
  const logs = []
  const pipeline = runPipeline({
    engine: 'js',
    nodePath: process.execPath,
    scriptPath: path.join(ROOT, 'scripts', 'highlight.mjs'),
    source: REPLAY,
    outDir,
    scanFps: 2,
    chunkSize: 60,
    localId: '乐邦詹士',
    ocrExe: path.join(ROOT, 'kfocr', 'target', 'release', 'kfocr.exe')
  }, {
    onEvent: (event) => events.push(event),
    onLog: (line) => logs.push(line)
  })
  const result = await pipeline.done
  if (result.code !== 0) {
    console.error(`[FAIL] --spawn 退出码 ${result.code}${result.error ? `：${result.error}` : ''}`)
    console.error(logs.slice(-5).join('\n'))
    process.exit(1)
  }
  const killEvent = events.find((e) => e.ev === 'kills')
  const resultEvent = events.find((e) => e.ev === 'result')
  assert.ok(killEvent && resultEvent, '事件流缺少 kills / result')
  assert.equal(resultEvent.localId, '乐邦詹士')
  assert.equal(resultEvent.kills, 3)
  console.log(`[PASS] --spawn：js 引擎事件 ${events.length} 条，${resultEvent.kills} 杀 / ${resultEvent.segments} 段，成片 ${resultEvent.output}`)
  await fs.rm(outDir, { recursive: true, force: true })
}
