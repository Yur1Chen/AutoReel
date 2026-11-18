/**
 * scripts/test-marker.mjs —— 「行首黄框」采样的双实现对照。
 *
 * PS 版用 System.Drawing 逐像素读 PNG；JS 引擎改成 kfocr --marker 解码同一张图。
 * 这里在同一批图上各跑一遍，比较数值差和阈值（≥3.0）分类是否一致 —— 分类不一致才会
 * 改变自动判定的样本集，数值差只要远小于阈值就没影响。
 *
 * 用法：
 *   node scripts/test-marker.mjs --work <含 rows.json 的中间产物目录> [--ocr <exe>]
 *   （先用 `node scripts/highlight.mjs ... --keep-work` 留一份现场）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupCapture, runProcess } from './lib/proc.mjs'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(SCRIPTS)

const argv = process.argv.slice(2)
const argValue = name => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const work = argValue('--work')
if (!work) {
  console.error('用法: node scripts/test-marker.mjs --work <含 rows.json 的中间产物目录> [--ocr <exe>]')
  console.error('（先用 `node scripts/highlight.mjs ... --keep-work` 留一份现场）')
  process.exit(2)
}
const workDir = path.resolve(work)
const ocrExe = path.resolve(argValue('--ocr') ?? path.join(ROOT, 'kfocr', 'target', 'release', 'kfocr.exe'))
const THRESHOLD = 3.0

const rows = JSON.parse((await fs.readFile(path.join(workDir, 'rows.json'), 'utf8')).replace(/^\uFEFF/, ''))
const paths = [...new Set((Array.isArray(rows) ? rows : [rows]).filter(r => r.text && r.path).map(r => r.path))]
const listFile = path.join(workDir, 'marker_list.txt')
await fs.writeFile(listFile, paths.join('\n'), 'utf8')

const { stdout: jsOut } = await runProcess(ocrExe, ['--quiet', '--marker', '0.5', '--list', listFile])
const jsScores = new Map()
for (const line of jsOut.split(/\r?\n/)) {
  if (!line.startsWith('M\t')) continue
  const [, file, score] = line.split('\t')
  jsScores.set(file, Number(score))
}

const { stdout: psOut } = await runProcess('pwsh', [
  '-NoProfile', '-File', path.join(SCRIPTS, 'lib', 'marker-ps.ps1'), '-PathsFile', listFile
])
const psScores = new Map()
for (const line of psOut.split(/\r?\n/)) {
  const tab = line.indexOf('\t')
  if (tab < 0) continue
  psScores.set(line.slice(0, tab), Number(line.slice(tab + 1)))
}

let maxDiff = 0
let classMismatch = 0
const worst = []
for (const file of paths) {
  const a = psScores.get(file)
  const b = jsScores.get(file)
  if (a === undefined || b === undefined) {
    classMismatch++
    worst.push({ file, ps: a, js: b, diff: Infinity })
    continue
  }
  const diff = Math.abs(a - b)
  maxDiff = Math.max(maxDiff, diff)
  if ((a >= THRESHOLD) !== (b >= THRESHOLD)) {
    classMismatch++
    worst.push({ file, ps: a, js: b, diff })
  }
}
worst.sort((x, y) => y.diff - x.diff)

console.log(`样本 ${paths.length} 张（${path.basename(workDir)}）`)
console.log(`阈值 ${THRESHOLD}% 分类不一致: ${classMismatch} 张`)
console.log(`最大数值差: ${maxDiff.toFixed(6)} 个百分点`)
for (const w of worst.slice(0, 5)) {
  console.log(`  差异 ${w.file}: PS=${w.ps} JS=${w.js}`)
}
await cleanupCapture()
process.exitCode = classMismatch === 0 ? 0 : 1

