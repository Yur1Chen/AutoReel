/**
 * scripts/test-client.mjs —— 客户端模块的注册自测（不渲染 React）。
 *
 * 用假的 window.__ModuleLoader__ 收下 factory，再用最小 React 桩和假 ctx 调 apply()，
 * 检查：inject 列表、右侧栏 tab 类型定义、两个 slot 的注册 key。
 * 视觉与交互仍要在浏览器里看（这里不渲染组件）。
 *
 * 用法：node scripts/test-client.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'plugin', 'client.js')

let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load (def) { definition = def }
  }
}

// client.js 是普通脚本，用 Function 执行而不是 import（它依赖 window 与 factory 注入的 require）
const source = fs.readFileSync(CLIENT, 'utf8')
new Function(source)()

assert.ok(definition, 'client.js 没有调用 __ModuleLoader__.load')
assert.equal(definition.id, '@local/auto-reel')

const React = {
  createElement: (...args) => ({ type: args[0], props: args[1] }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  Fragment: 'Fragment'
}
const mod = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

assert.deepEqual(mod.inject.sort(), ['locale', 'sidebarRightTabs', 'slots'].sort())

const registrations = []
const ctx = {
  effect (fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  locale: {
    bind: (ns) => (key) => `${ns}.${key}`,
    register: (ns, dictionaries) => registrations.push({ kind: 'locale', ns, languages: Object.keys(dictionaries) })
  },
  sidebarRightTabs: {
    register: (def) => { registrations.push({ kind: 'tab', def }); return () => {} }
  },
  sidebarRight: {},
  slots: {
    inject (owner, callback) { registrations.push({ kind: 'inject', owner }); callback(); return () => {} },
    register (options, component) {
      registrations.push({ kind: 'slot', name: options.name, key: options.key, component })
      return () => {}
    }
  }
}

mod.apply(ctx)

const tab = registrations.find((r) => r.kind === 'tab')
assert.ok(tab, '没有注册右侧栏 tab 类型')
assert.equal(tab.def.id, '@local/auto-reel/panel')
assert.equal(tab.def.kind, 'auto-reel')
assert.equal(typeof tab.def.title, 'function')
assert.ok(Array.isArray(tab.def.guide) && tab.def.guide.length === 1, 'guide 条目应为 1 个')
assert.equal(typeof tab.def.guide[0].title, 'function')
assert.equal(typeof tab.def.guide[0].description, 'function')

const body = registrations.find((r) => r.kind === 'slot' && r.name === 'sidebar.right.pane.tab')
assert.ok(body, '没有注册侧栏面板 body')
assert.equal(body.key, '@local/auto-reel/panel')
assert.equal(typeof body.component, 'function')

const card = registrations.find((r) => r.kind === 'slot' && r.name === 'tool.call.toolview')
assert.ok(card, '没有注册工具卡片')
assert.equal(card.key, 'auto_reel')

const locale = registrations.find((r) => r.kind === 'locale')
assert.ok(locale && locale.languages.includes('zh') && locale.languages.includes('en'), '中英文字典缺失')

console.log(`[PASS] client 注册：tab=${tab.def.id} kind=${tab.def.kind}，面板与工具卡片都在，中英文字典齐全`)
