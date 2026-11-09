/**
 * 运行时 action 离线测试：mock ctx（manager / registry / tools.definitions），
 * 不启动 DSH、不连真实服务、不碰真实 ~/.dsh。
 *
 * 动态 import dsh-mcp-client 在测试环境必然失败（包不在解析路径）→ 自动降级，
 * 这正好覆盖「import 失败 → tools 兜底 / unavailable」链路。fiber 全量状态走真机验证。
 *
 * 运行：node --test plugin/test/runtime.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const FIX = path.resolve(PLUGIN, '..', 'test', 'fixtures')

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) copyDirSync(s, d)
    else fs.copyFileSync(s, d)
  }
}

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-runtime-'))
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  copyDirSync(FIX, home)
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return { home }
}

/** mock ctx：可选 manager、tools.definitions、registry runtimes。 */
function makeCtx(opts = {}) {
  let tool = null
  const warnings = []
  const tools = { register: (x) => { tool = x } }
  if (!opts.noDefinitions) tools.definitions = () => opts.toolDefs || []
  const ctx = {
    tools,
    logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
    effect: (fn) => { try { return fn() } catch { return undefined } },
    get: (name) => (name === 'mcpManager' ? opts.manager : undefined),
    registry: { values: () => (opts.runtimes || [])[Symbol.iterator]() }
  }
  return { ctx, tool: () => tool, warnings }
}

async function exec(ctx, args) {
  const { tool } = { tool: null }
  // apply 注册工具后取 execute
  let registered = null
  ctx.tools.register = (x) => { registered = x }
  apply(ctx, { enabled: true })
  return JSON.parse(await registered.execute(args))
}

test('R1) runtime_list：manager 状态优先 + 与配置名合并', async (t) => {
  setup(t)
  const manager = {
    list: () => [{ name: 'volatile-a', configured: true, status: { state: 'connected', toolCount: 5 } }]
  }
  const { ctx } = makeCtx({ manager, toolDefs: [] })
  const obj = await exec(ctx, { action: 'runtime_list' })
  assert.equal(obj.ok, true, JSON.stringify(obj))
  assert.equal(obj.data.runtime, 'ok')
  const va = obj.data.servers.find((s) => s.serverName === 'volatile-a')
  assert.ok(va, '应含 manager server')
  assert.equal(va.state, 'connected')
  assert.equal(va.toolCount, 5)
  assert.equal(va.source, 'manager')
  // 配置里的 client 名（snowluma）走 tools 兜底
  assert.ok(obj.data.servers.some((s) => s.serverName === 'snowluma'))
})

test('R2) runtime_list：无 manager → tools.definitions 前缀计数兜底', async (t) => {
  setup(t)
  const toolDefs = [
    { name: 'mcp__snowluma__send' }, { name: 'mcp__snowluma__read' },
    { name: 'mcp__exa__search' }, { name: 'builtin_tool' }
  ]
  const { ctx } = makeCtx({ toolDefs })
  const obj = await exec(ctx, { action: 'runtime_list' })
  assert.equal(obj.data.runtime, 'ok')
  const sn = obj.data.servers.find((s) => s.serverName === 'snowluma')
  assert.equal(sn.toolCount, 2)
  assert.equal(sn.source, 'tools')
  assert.equal(sn.state, 'unknown')
  const exa = obj.data.servers.find((s) => s.serverName === 'exa')
  assert.equal(exa.toolCount, 1)
})

test('R3) runtime_list：三路全缺 → unavailable，不抛错', async (t) => {
  setup(t)
  const { ctx } = makeCtx({ noDefinitions: true })
  const obj = await exec(ctx, { action: 'runtime_list' })
  assert.equal(obj.ok, true)
  assert.equal(obj.data.runtime, 'unavailable')
  assert.deepEqual(obj.data.servers, [])
})

test('R4) runtime_probe：manager 条目返回延迟', async (t) => {
  setup(t)
  const manager = {
    list: () => [{ name: 'volatile-a', configured: true, status: { state: 'connected' } }],
    probe: async (name, opts) => {
      assert.equal(name, 'volatile-a')
      assert.equal(opts.timeoutMs, 15000)
      return { ok: true, durationMs: 42, toolNames: ['t1'], closeConfirmed: true }
    }
  }
  const { ctx } = makeCtx({ manager })
  const obj = await exec(ctx, { action: 'runtime_probe', name: 'volatile-a' })
  assert.equal(obj.ok, true)
  assert.equal(obj.data.ok, true)
  assert.equal(obj.data.source, 'manager')
  assert.equal(obj.data.result.durationMs, 42)
})

test('R5) runtime_probe：无 manager 且 import 失败 → ok:false 降级', async (t) => {
  setup(t)
  const { ctx } = makeCtx({})
  const obj = await exec(ctx, { action: 'runtime_probe', name: 'snowluma' })
  assert.equal(obj.ok, true) // action 执行成功
  assert.equal(obj.data.ok, false) // 探测不可用
  assert.ok(/probe unavailable/.test(obj.data.error))
})

test('R6) runtime_restart：confirm 门（不带不执行，带了才重启）', async (t) => {
  setup(t)
  const calls = []
  const manager = {
    list: () => [{ name: 'volatile-a', configured: true, status: { state: 'connected' } }],
    restart: async (name) => { calls.push(name) }
  }
  const { ctx } = makeCtx({ manager })
  // 不带 confirm
  let registered = null
  ctx.tools.register = (x) => { registered = x }
  apply(ctx, { enabled: true })
  const preview = JSON.parse(await registered.execute({ action: 'runtime_restart', name: 'volatile-a' }))
  assert.equal(preview.applied, false)
  assert.equal(preview.confirm, false)
  assert.ok(preview.preview)
  assert.deepEqual(calls, [], '未 confirm 不应重启')
  // 带 confirm
  const applied = JSON.parse(await registered.execute({ action: 'runtime_restart', name: 'volatile-a', confirm: true }))
  assert.equal(applied.applied, true)
  assert.equal(applied.confirm, true)
  assert.equal(applied.ok, true)
  assert.equal(applied.source, 'manager')
  assert.deepEqual(calls, ['volatile-a'])
})

test('R7) runtime_restart：未知 server → ok:false', async (t) => {
  setup(t)
  const { ctx } = makeCtx({})
  const obj = await exec(ctx, { action: 'runtime_restart', name: 'nope', confirm: true })
  assert.equal(obj.ok, false)
  assert.ok(/找不到运行时 server/.test(obj.error))
})

test('R8) 工具 schema 含三个 runtime action', async (t) => {
  setup(t)
  const { ctx, tool } = makeCtx({})
  apply(ctx, { enabled: true })
  const enumVals = tool().parameters.properties.action.enum
  for (const a of ['runtime_list', 'runtime_probe', 'runtime_restart']) {
    assert.ok(enumVals.includes(a), `schema 缺 ${a}`)
  }
})