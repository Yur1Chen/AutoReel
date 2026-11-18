/**
 * 回放目录扫描与素材名归一化。
 *
 * 素材名规则沿用 scripts/highlight.ps1：去掉 "Valorant " 前缀与 ".DVR" 后缀，
 * 它同时是 out/<素材名>/ 的目录名，所以列表页和成片能一一对上。
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv'])

/** 与 highlight.ps1 的 $stem 保持一致。 */
export function stemOf (filePath) {
  return path.basename(filePath).replace(/\.(mp4|m4v|mov|mkv)$/i, '').replace(/^Valorant\s+/, '').replace(/\.DVR$/i, '')
}

/**
 * 列出一个目录里的录像，按修改时间倒序。
 * @returns {Promise<Array<{path: string, name: string, stem: string, sizeMb: number, mtime: number, dvr: boolean}>>}
 */
export async function listReplays (dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw new Error(`回放目录不可读: ${dir}（${error.code ?? error.message}）`)
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) continue
    const full = path.join(dir, entry.name)
    try {
      const info = await stat(full)
      out.push({
        path: full,
        name: entry.name,
        stem: stemOf(full),
        sizeMb: Math.round(info.size / 1024 / 1024 * 10) / 10,
        mtime: info.mtimeMs,
        dvr: /\.DVR\./i.test(entry.name)
      })
    } catch {
      // 文件刚好被删：跳过
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/**
 * 找"最新一条"。优先 NVIDIA 即时回放的 .DVR 文件，
 * 没有的话退回任意最新录像 —— 目录里常混着剪好的成片，别把成片当源。
 */
export async function latestReplay (dir) {
  const all = await listReplays(dir)
  const dvr = all.filter((item) => item.dvr)
  const pool = dvr.length > 0 ? dvr : all
  if (pool.length === 0) throw new Error(`回放目录里没有录像: ${dir}`)
  return pool[0]
}

/** 列出 out/ 下已有的成片（作品库）。 */
export async function listReels (dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(dir, entry.name, 'highlight_reel.mp4')
    try {
      const info = await stat(file)
      out.push({ stem: entry.name, path: file, sizeMb: Math.round(info.size / 1024 / 1024 * 10) / 10, mtime: info.mtimeMs })
    } catch {
      // 该素材目录里没有成片
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}
