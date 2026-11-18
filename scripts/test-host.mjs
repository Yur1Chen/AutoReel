/**
 * scripts/test-host.mjs —— 插件 Host 半里不需要起引擎的部分：设置接口与校验。
 *
 * 用一个假 ctx 调 apply()，把注册到的 HTTP 路由抓出来直接调 handler，
 * 这样设置读写、参数校验（0–10 秒、绝对路径、文件存在）都能在没有 DSH 的情况下验。
 * 引擎/ffmpeg 相关路径不在这里覆盖（--spawn 在 test-plugin.mjs）。
 *
 * 用法：node scripts/test-host.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// SETTINGS_FILE 在模块加载时由 LOCALAPPDATA 决定，必须先改环境再 import
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoreel-host-test-'))
process.env.LOCALAPPDATA = sandbox

const { apply } = await import('../plugin/index.js')

const replaysDir = path.join(sandbox, 'replays')
const outputDir = path.join(sandbox, 'out')
fs.mkdirSync(replaysDir, { recursive: true })

const pickedDir = path.join(sandbox, 'picked')
fs.mkdirSync(pickedDir, { recursive: true })
const routes = []
const disposers = []
const ctx = {
  get (name) {
    if (name === 'directoryPicker') {
      return { capability: () => ({ kind: 'native', pick: async () => pickedDir }) }
    }
    return undefined
  },
  effect (fn) { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return disposer },
  tools: { register () { return () => {} } },
  webServer: { register (route) { routes.push(route); return () => {} } },
  clientModules: { graph () { return { rev: 'test', entries: [] } } }
}

apply(ctx, { replaysDir, outputDir })

const routeOf = (p) => routes.find((r) => r.path === p)
assert.ok(routeOf('/autoreel/api/settings'), 'settings 路由未注册')
assert.ok(routeOf('/autoreel/api/cut'), 'cut 路由未注册')

async function call (routePath, { method = 'GET', url = routePath, body } = {}) {
  const route = routeOf(routePath)
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator] () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    }
  }
  const res = {
    status: 0,
    headers: null,
    payload: '',
    writeHead (status, headers) { this.status = status; this.headers = headers },
    end (payload) { this.payload = payload || '' }
  }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(res.payload) } catch { json = res.payload }
  return { status: res.status, json }
}

// 1. 默认值来自配置
let res = await call('/autoreel/api/settings')
assert.equal(res.status, 200)
assert.equal(res.json.settings.replaysDir, replaysDir)
assert.equal(res.json.settings.outputDir, outputDir)
assert.equal(res.json.settings.pre, 3.5)
assert.equal(res.json.settings.post, 1.5)
assert.equal(res.json.settings.sourcePath, '')
console.log('[PASS] GET /api/settings 返回配置默认值')

// 2. 非法秒数被拒
res = await call('/autoreel/api/settings', { method: 'POST', body: { pre: 99 } })
assert.equal(res.status, 400)
assert.match(res.json.error, /0–10/)
console.log('[PASS] pre=99 被拒')

// 3a. 空回放目录被拒
res = await call('/autoreel/api/settings', { method: 'POST', body: { replaysDir: '' } })
assert.equal(res.status, 400)
assert.match(res.json.error, /不能为空/)
console.log('[PASS] 空回放目录被拒')

// 3b. 相对回放目录列表被拒
res = await call('/autoreel/api/replays', { url: '/autoreel/api/replays?dir=' + encodeURIComponent('relative') })
assert.equal(res.status, 400)
console.log('[PASS] 相对回放目录列表返回 400')

// 3. 相对输出目录被拒
res = await call('/autoreel/api/settings', { method: 'POST', body: { outputDir: 'relative/out' } })
assert.equal(res.status, 400)
assert.match(res.json.error, /绝对路径/)
console.log('[PASS] 相对输出目录被拒')

// 4. 不存在的回放被拒
res = await call('/autoreel/api/settings', { method: 'POST', body: { sourcePath: path.join(sandbox, 'nope.mp4') } })
assert.equal(res.status, 400)
assert.match(res.json.error, /不存在/)
console.log('[PASS] 不存在的回放被拒')

// 5. 合法保存写文件并生效
const nextOut = path.join(sandbox, 'out2')
res = await call('/autoreel/api/settings', {
  method: 'POST',
  body: { pre: 2.5, post: 1, outputDir: nextOut, sourcePath: '', replaysDir }
})
assert.equal(res.status, 200)
assert.equal(res.json.settings.pre, 2.5)
const settingsFile = path.join(sandbox, 'AutoReel', 'settings.json')
assert.ok(fs.existsSync(settingsFile), '设置文件没写出来')
const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
assert.equal(stored.pre, 2.5)
assert.ok(fs.existsSync(nextOut), '输出目录没有创建')
console.log('[PASS] 合法设置保存到文件并创建输出目录')

// 6. 再次 GET 读回覆盖值
res = await call('/autoreel/api/settings')
assert.equal(res.json.settings.pre, 2.5)
assert.equal(res.json.settings.outputDir, nextOut)
console.log('[PASS] GET 读回保存后的值')

// 7. 回放列表拒绝不存在的目录
res = await call('/autoreel/api/replays', { url: '/autoreel/api/replays?dir=' + encodeURIComponent(path.join(sandbox, 'nope')) })
assert.equal(res.status, 400)
console.log('[PASS] 不存在的回放目录返回 400')

// 7b. 目录选择服务：返回选中的绝对路径
res = await call('/autoreel/api/pick-dir', { method: 'POST', body: {} })
assert.equal(res.status, 200)
assert.equal(res.json.path, pickedDir)
console.log('[PASS] /api/pick-dir 调用 directoryPicker 并返回路径')

// 8. cut：不存在的源在起引擎前就被拒
res = await call('/autoreel/api/cut', { method: 'POST', body: { source: path.join(sandbox, 'nope.mp4') } })
assert.equal(res.status, 400)
assert.match(res.json.error, /不存在/)
console.log('[PASS] cut 不存在的源返回 400')

for (const dispose of disposers) dispose()
fs.rmSync(sandbox, { recursive: true, force: true })
console.log('全部通过')
