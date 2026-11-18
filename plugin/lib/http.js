/**
 * 插件自带的 HTTP 小工具：JSON 响应、请求体读取、带 Range 的文件下发。
 *
 * 刻意不依赖任何 Host 内部模块 —— 路由拿到的就是 Node 的 IncomingMessage /
 * ServerResponse（见 dsh-host-webserver 的 WebRoute.handler）。
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8'
}

function baseHeaders (extra = {}) {
  return {
    'Cache-Control': 'no-store',
    // 桌面版可能以 file:// 载入页面，此时页面 origin 是 null；原型阶段直接放开只读接口。
    'Access-Control-Allow-Origin': '*',
    ...extra
  }
}

/** 回一个 JSON 响应。 */
export function sendJson (res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  }))
  res.end(body)
}

/** 回一个纯文本错误（也给 404/405 用）。 */
export function sendText (res, status, text) {
  res.writeHead(status, baseHeaders({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  }))
  res.end(text)
}

/** 读一个 JSON 请求体；超过 limit 直接拒绝，避免把内存撑爆。 */
export async function readJsonBody (req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function parseRange (header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    // bytes=-N：最后 N 字节
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 下发一个磁盘文件，支持单段 Range（视频拖动进度条必需）。
 * 只读；调用方负责把绝对路径限制在允许的目录内。
 */
export async function serveFile (req, res, absPath) {
  let info
  try {
    info = await stat(absPath)
  } catch {
    sendText(res, 404, 'not found')
    return
  }
  if (!info.isFile()) { sendText(res, 404, 'not found'); return }

  const type = MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream'
  const size = info.size
  const range = req.headers.range === undefined ? null : parseRange(req.headers.range, size)

  if (req.headers.range !== undefined && range === null) {
    res.writeHead(416, baseHeaders({ 'Content-Range': `bytes */${size}` }))
    res.end()
    return
  }

  if (range === null) {
    res.writeHead(200, baseHeaders({
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Last-Modified': info.mtime.toUTCString()
    }))
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(absPath).on('error', () => res.destroy()).pipe(res)
    return
  }

  res.writeHead(206, baseHeaders({
    'Content-Type': type,
    'Content-Length': range.end - range.start + 1,
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Last-Modified': info.mtime.toUTCString()
  }))
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(absPath, { start: range.start, end: range.end })
    .on('error', () => res.destroy())
    .pipe(res)
}
