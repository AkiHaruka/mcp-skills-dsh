/**
 * 离线加载测试：mock ctx，不启动 DSH、不连 instabox、不碰真实 ~/.dsh。
 * 所有数据指向 mkdtemp 出来的 fixture 副本。
 *
 * 运行：node --test plugin/test/offline.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const FIX = path.resolve(PLUGIN, '..', 'test', 'fixtures')

// 本机定制 node 的 fs.cpSync 存在 native 崩溃，改用纯 JS 递归复制。
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) copyDirSync(s, d)
    else fs.copyFileSync(s, d)
  }
}

/** 每个用例独立的 fixture 副本 + 隔离的 DSH_HOME。 */
function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-offline-'))
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  copyDirSync(FIX, home)
  const patch = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')

  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return { tmp, home, patch }
}

/** mock ctx：{ tools:{register}, logger:{warn}, effect }。 */
function makeCtx(register) {
  const warnings = []
  const ctx = {
    tools: { register },
    logger: {
      warn: (m) => warnings.push(String(m)),
      info: () => {}
    },
    effect: (fn) => { try { return fn() } catch { return undefined } }
  }
  return { ctx, warnings }
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

test('1) apply 注册 dsh_admin 工具（含 parameters/output/execute）', (t) => {
  setup(t)
  let tool = null
  const { ctx } = makeCtx((x) => { tool = x })
  apply(ctx, { enabled: true })

  assert.ok(tool, '工具应被注册')
  assert.equal(tool.name, 'dsh_admin')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.output.schema.type, 'string')
  assert.equal(typeof tool.output.render, 'function')
  assert.deepEqual(tool.output.render(null, 'hello'), [{ type: 'text', text: 'hello' }])
  const props = tool.parameters.properties
  for (const k of ['action', 'target', 'id', 'name', 'enabled', 'confirm', 'entry', 'description']) {
    assert.ok(props[k], `parameters 缺少 ${k}`)
  }
  assert.ok(props.action.enum.includes('status'))
  assert.equal(props.entry.type, 'object')
})

test('2) execute(status) 指向 fixture 返回 mcpCount=3 / skillsCount=3', async (t) => {
  const { home, patch } = setup(t)
  let tool = null
  const { ctx } = makeCtx((x) => { tool = x })
  apply(ctx, { enabled: true })

  const out = await tool.execute({ action: 'status' })
  const obj = JSON.parse(out)
  assert.equal(obj.ok, true, out)
  assert.equal(obj.mcpCount, 3)
  assert.equal(obj.skillsCount, 3)
  assert.equal(obj.data.mcpCount, 3)
  assert.equal(obj.data.skillsCount, 3)
  assert.equal(obj.patchExists, true)
  assert.equal(obj.dshHome, home)
  assert.ok(obj.patchPath.endsWith(path.join('profiles', 'desktop', 'cordis.patch.yml')))
  assert.equal(fs.existsSync(patch), true)
})

test('3) 写操作不带 confirm 时 dry-run 且绝不改文件（哈希/mtime/无备份）', async (t) => {
  const { patch } = setup(t)
  const before = fs.readFileSync(patch)
  const hashBefore = sha(before)
  const mtimeBefore = fs.statSync(patch).mtimeMs
  const dir = path.dirname(patch)
  const junkBefore = fs.readdirSync(dir).filter((f) => /bak-|\.tmp-/.test(f))

  let tool = null
  const { ctx } = makeCtx((x) => { tool = x })
  apply(ctx, { enabled: true })

  const out = await tool.execute({ action: 'set_mcp_enabled', target: 'mcp-exa', enabled: false })
  const obj = JSON.parse(out)
  assert.equal(obj.applied, false, out)
  assert.equal(obj.dryRun, true)
  assert.equal(obj.confirm, false)

  const after = fs.readFileSync(patch)
  assert.equal(sha(after), hashBefore, '内容哈希不变')
  assert.equal(fs.statSync(patch).mtimeMs, mtimeBefore, 'mtime 不变')
  const junkAfter = fs.readdirSync(dir).filter((f) => /bak-|\.tmp-/.test(f))
  assert.deepEqual(junkAfter, junkBefore, '不生成备份/临时文件')
})

test('4) config.enabled:false 时不注册工具', (t) => {
  setup(t)
  let registered = false
  const { ctx, warnings } = makeCtx(() => { registered = true })
  apply(ctx, { enabled: false })
  assert.equal(registered, false, '不应注册工具')
  assert.ok(warnings.some((w) => w.includes('熔断')), '应记录熔断日志')
})

test('5) 顶层异常不抛出：register 抛错被隔离', (t) => {
  setup(t)
  const { ctx, warnings } = makeCtx(() => { throw new Error('boom-register') })
  assert.doesNotThrow(() => apply(ctx, { enabled: true }))
  assert.ok(warnings.some((w) => w.includes('boom-register') || w.includes('异常') || w.includes('隔离')))
})

test('5b) execute 内部异常不外抛，返回 ok:false', async (t) => {
  setup(t)
  let tool = null
  const { ctx } = makeCtx((x) => { tool = x })
  apply(ctx, { enabled: true })
  const out = await tool.execute({ action: 'remove_mcp', id: 'does-not-exist', confirm: true })
  const obj = JSON.parse(out)
  assert.equal(obj.ok, false)
  assert.ok(obj.error && String(obj.error).length > 0)
})

test('5c) apply(null/undefined) 不抛', () => {
  assert.doesNotThrow(() => apply(null, { enabled: true }))
  assert.doesNotThrow(() => apply(undefined, {}))
})

test('6) confirm:true 才真正落盘并生成 .bak- 备份', async (t) => {
  const { patch } = setup(t)
  const before = fs.readFileSync(patch, 'utf8')
  let tool = null
  const { ctx } = makeCtx((x) => { tool = x })
  apply(ctx, { enabled: true })

  const out = await tool.execute({ action: 'set_mcp_enabled', id: 'mcp-snowluma', enabled: false, confirm: true })
  const obj = JSON.parse(out)
  assert.equal(obj.confirm, true, out)
  assert.equal(obj.dryRun, false)
  assert.equal(obj.applied, true)

  const after = fs.readFileSync(patch, 'utf8')
  assert.notEqual(after, before, '文件应改变')
  const baks = fs.readdirSync(path.dirname(patch))
    .filter((f) => /^cordis\.patch\.yml\.bak-\d{8}-\d{6}$/.test(f))
  assert.ok(baks.length >= 1, '应生成 .bak- 备份')
})

test('7) update_mcp 在 action enum 中；dry-run 不改文件且返回 diff', async (t) => {
  const { patch } = setup(t)
  const hashBefore = sha(fs.readFileSync(patch))
  let tool = null
  const { ctx } = makeCtx((x) => { tool = x })
  apply(ctx, { enabled: true })
  assert.ok(tool.parameters.properties.action.enum.includes('update_mcp'))

  const out = await tool.execute({
    action: 'update_mcp', id: 'mcp-snowluma',
    entry: { toolCallTimeoutMs: 999, args: ['a.js', 'b.js'] }
  })
  const obj = JSON.parse(out)
  assert.equal(obj.ok, true, out)
  assert.equal(obj.applied, false)
  assert.equal(obj.dryRun, true)
  assert.equal(obj.confirm, false)
  assert.ok(obj.diff, 'dry-run 应返回 diff')
  assert.equal(sha(fs.readFileSync(patch)), hashBefore, 'dry-run 内容哈希不变')
  const junk = fs.readdirSync(path.dirname(patch)).filter((f) => /bak-|\.tmp-/.test(f))
  assert.deepEqual(junk, [], 'dry-run 不生成备份/临时文件')
})

test('7b) update_mcp confirm:true 落盘：字段生效、!!js 与注释保留、有备份', async (t) => {
  const { patch } = setup(t)
  let tool = null
  const { ctx } = makeCtx((x) => { tool = x })
  apply(ctx, { enabled: true })

  const out = await tool.execute({
    action: 'update_mcp', id: 'mcp-snowluma', confirm: true,
    entry: { toolCallTimeoutMs: 999, args: ['a.js', 'b.js'], env: { FOO: 'bar' } }
  })
  const obj = JSON.parse(out)
  assert.equal(obj.ok, true, out)
  assert.equal(obj.applied, true)
  assert.equal(obj.dryRun, false)

  const got = JSON.parse(await tool.execute({ action: 'get_mcp', id: 'mcp-snowluma' }))
  assert.equal(got.data.toolCallTimeoutMs, 999)
  assert.deepEqual(got.data.args, ['a.js', 'b.js'])
  assert.deepEqual(got.data.env, { FOO: 'bar' })
  const txt = fs.readFileSync(patch, 'utf8')
  assert.match(txt, /beforeHook: !!js \|/, '!!js 节点原样保留')
  assert.match(txt, /# === qq-bridge MCP END ===/, '注释保留')
  const baks = fs.readdirSync(path.dirname(patch))
    .filter((f) => /^cordis\.patch\.yml\.bak-\d{8}-\d{6}$/.test(f))
  assert.ok(baks.length >= 1, '应生成 .bak- 备份')
})

test('7c) update_mcp 切 transport 清互斥字段（stdio↔http 双向）', async (t) => {
  const { patch } = setup(t)
  let tool = null
  const { ctx } = makeCtx((x) => { tool = x })
  apply(ctx, { enabled: true })

  // stdio → streamable-http：command/args/cwd 应被清掉
  const toHttp = JSON.parse(await tool.execute({
    action: 'update_mcp', id: 'mcp-snowluma', confirm: true,
    entry: { transport: 'streamable-http', url: 'https://example.test/mcp', headers: { X: '1' } }
  }))
  assert.equal(toHttp.ok, true, JSON.stringify(toHttp))
  let e = JSON.parse(await tool.execute({ action: 'get_mcp', id: 'mcp-snowluma' })).data
  assert.equal(e.transport, 'streamable-http')
  assert.equal(e.url, 'https://example.test/mcp')
  assert.equal(e.command, null)
  assert.deepEqual(e.args, [])

  // streamable-http → stdio：url/headers 应被清掉
  const toStdio = JSON.parse(await tool.execute({
    action: 'update_mcp', id: 'mcp-exa', confirm: true,
    entry: { transport: 'stdio', command: 'node', args: ['s.js'] }
  }))
  assert.equal(toStdio.ok, true, JSON.stringify(toStdio))
  e = JSON.parse(await tool.execute({ action: 'get_mcp', id: 'mcp-exa' })).data
  assert.equal(e.transport, 'stdio')
  assert.equal(e.command, 'node')
  assert.equal(e.url, null)
  assert.deepEqual(e.headers, {})
})

test('7d) update_mcp 校验失败 / 未知 id：ok:false 且 confirm:true 也不落盘', async (t) => {
  const { patch } = setup(t)
  const hashBefore = sha(fs.readFileSync(patch))
  let tool = null
  const { ctx } = makeCtx((x) => { tool = x })
  apply(ctx, { enabled: true })

  const bad = JSON.parse(await tool.execute({
    action: 'update_mcp', id: 'mcp-snowluma', confirm: true, entry: { command: '' }
  }))
  assert.equal(bad.ok, false)
  assert.match(String(bad.error), /command/)

  const missing = JSON.parse(await tool.execute({
    action: 'update_mcp', id: 'does-not-exist', confirm: true, entry: { cwd: '/tmp' }
  }))
  assert.equal(missing.ok, false)
  assert.match(String(missing.error), /找不到/)
  assert.equal(sha(fs.readFileSync(patch)), hashBefore, '失败时内容哈希不变')
})
