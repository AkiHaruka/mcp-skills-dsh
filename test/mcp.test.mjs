import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listMcp, getMcp, addMcp, updateMcp, removeMcp, setMcpEnabled, validateMcpEntry, validateAll
} from '../lib/index.mjs'

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

// 本机定制 node 的 fs.cpSync 存在 native 崩溃，改用纯 JS 递归复制
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-mcp-'))
  const dshHome = path.join(tmp, 'home')
  fs.mkdirSync(dshHome, { recursive: true })
  copyDirSync(FIX, dshHome)
  const patch = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  return { tmp, dshHome, patch }
}

test('listMcp 识别 stdio / streamable-http / mcp-manager.servers 三类', (t) => {
  const { patch } = setup(t)
  const list = listMcp(patch)
  assert.equal(list.length, 3)

  const snow = list.find((e) => e.id === 'mcp-snowluma')
  assert.equal(snow.serverName, 'snowluma')
  assert.equal(snow.transport, 'stdio')
  assert.equal(snow.enabled, true)
  assert.match(String(snow.command), /node\.exe/)
  assert.equal(snow.args.length, 1)
  assert.equal(snow.raw.kind, 'client')
  // !!js 节点被当字符串读回，不求值
  assert.equal(typeof snow.raw.config.beforeHook, 'string')

  const exa = list.find((e) => e.id === 'mcp-exa')
  assert.equal(exa.transport, 'streamable-http')
  assert.equal(exa.enabled, false) // fixture 里有 disabled:true 覆盖行
  assert.match(String(exa.url), /^https:\/\//)
  assert.equal(exa.headers['X-Test'], '1')

  const vol = list.find((e) => e.id === 'volatile-a')
  assert.equal(vol.raw.kind, 'manager')
  assert.equal(vol.serverName, 'volatile-a')
})

test('dry-run 不落盘且返回 diff', (t) => {
  const { patch } = setup(t)
  const before = fs.readFileSync(patch, 'utf8')
  const r = addMcp(patch, { id: 'mcp-demo', serverName: 'demo', transport: 'stdio', command: 'node' })
  assert.equal(r.applied, false)
  assert.equal(r.backupPath, null)
  assert.equal(fs.readFileSync(patch, 'utf8'), before, '文件内容必须逐字节不变')
  assert.match(r.diff, /mcp-demo/)
  assert.match(r.diff, /\+/)
})

test('apply 落盘、自动备份存在、!!js 节点与注释 round-trip 保留', (t) => {
  const { patch } = setup(t)
  const r = addMcp(patch, {
    id: 'mcp-demo', serverName: 'demo', transport: 'stdio', command: 'node', args: ['demo.js']
  }, { apply: true })
  assert.equal(r.applied, true, r.error)
  assert.ok(r.backupPath && fs.existsSync(r.backupPath), '备份文件应存在')
  assert.match(r.backupPath, /\.bak-\d{8}-\d{6}$/)

  const txt = fs.readFileSync(patch, 'utf8')
  assert.match(txt, /beforeHook: !!js \|/, '!!js 节点必须原样保留')
  assert.match(txt, /\(ctx\) => ctx\.logger/, '!!js 块内容必须保留')
  assert.match(txt, /# === qq-bridge MCP BEGIN ===/, '注释必须保留')
  assert.match(txt, /# 覆盖行：用 disabled:true/, '覆盖行注释必须保留')
  assert.match(txt, /command: 'C:\\Program Files\\nodejs\\node\.exe'/, '单引号必须保留')
  assert.equal(listMcp(patch).length, 4)
})

test('写后解析回读一致：新增条目可被正确列出', (t) => {
  const { patch } = setup(t)
  addMcp(patch, { id: 'mcp-demo', serverName: 'demo', transport: 'streamable-http', url: 'https://example.com/mcp' }, { apply: true })
  const e = getMcp(patch, 'mcp-demo')
  assert.ok(e)
  assert.equal(e.transport, 'streamable-http')
  assert.equal(e.url, 'https://example.com/mcp')
})

test('重复 id 被拒绝', (t) => {
  const { patch } = setup(t)
  const existing = listMcp(patch)
  const v = validateMcpEntry({ id: 'mcp-exa', serverName: 'other', transport: 'stdio', command: 'node' }, existing)
  assert.equal(v.valid, false)
  assert.match(v.errors.join('；'), /重复 id/)
  assert.throws(
    () => addMcp(patch, { id: 'mcp-exa', serverName: 'other', transport: 'stdio', command: 'node' }, { apply: true }),
    /重复 id/
  )
})

test('重复 serverName 被拒绝', (t) => {
  const { patch } = setup(t)
  const v = validateMcpEntry({ id: 'brand-new', serverName: 'snowluma', transport: 'stdio', command: 'node' }, listMcp(patch))
  assert.equal(v.valid, false)
  assert.match(v.errors.join('；'), /重复 serverName/)
})

test('非法 transport / serverName / 必填字段被拒绝', (t) => {
  const base = { id: 'x', serverName: 'x', transport: 'stdio', command: 'node' }
  assert.equal(validateMcpEntry({ ...base, transport: 'sse' }).valid, false)
  assert.equal(validateMcpEntry({ ...base, serverName: 'bad.name!' }).valid, false)
  assert.equal(validateMcpEntry({ ...base, serverName: '' }).valid, false)
  assert.equal(validateMcpEntry({ ...base, command: '' }).valid, false)
  assert.equal(validateMcpEntry({ ...base, transport: 'streamable-http', url: '' }).valid, false)
  const { patch } = setup(t)
  assert.throws(() => addMcp(patch, { ...base, id: 'bad-tr', transport: 'sse' }, { apply: true }), /transport/)
})

test('updateMcp 改字段、切 transport 清互斥、保留 !!js', (t) => {
  const { patch } = setup(t)
  const r = updateMcp(patch, 'mcp-snowluma', {
    toolCallTimeoutMs: 999, transport: 'streamable-http', url: 'https://new.example/mcp'
  }, { apply: true })
  assert.equal(r.applied, true, r.error)
  const e = getMcp(patch, 'mcp-snowluma')
  assert.equal(e.transport, 'streamable-http')
  assert.equal(e.url, 'https://new.example/mcp')
  assert.equal(e.toolCallTimeoutMs, 999)
  assert.equal(e.command, null, '切到 http 应清掉 command')
  const txt = fs.readFileSync(patch, 'utf8')
  assert.match(txt, /beforeHook: !!js \|/, 'update 不能破坏 !!js 节点')
  assert.match(txt, /# === qq-bridge MCP END ===/, '注释仍在')
})

test('removeMcp 删除条目且回读一致', (t) => {
  const { patch } = setup(t)
  const r = removeMcp(patch, 'mcp-snowluma', { apply: true })
  assert.equal(r.applied, true, r.error)
  assert.equal(getMcp(patch, 'mcp-snowluma'), null)
  assert.match(fs.readFileSync(patch, 'utf8'), /mcp-exa/, '其他条目不受影响')
})

test('setMcpEnabled 用 disabled:true 覆盖行禁用，不删原配置；可再启用', (t) => {
  const { patch } = setup(t)
  // 先启用 fixture 里已被禁用的 exa
  const en = setMcpEnabled(patch, 'mcp-exa', true, { apply: true })
  assert.equal(en.applied, true, en.error)
  assert.equal(getMcp(patch, 'mcp-exa').enabled, true)

  const dis = setMcpEnabled(patch, 'mcp-exa', false, { apply: true })
  assert.equal(dis.applied, true, dis.error)
  assert.equal(getMcp(patch, 'mcp-exa').enabled, false)
  const txt = fs.readFileSync(patch, 'utf8')
  assert.match(txt, /- id: mcp-exa\n\s+disabled: true/, '应生成 disabled:true 覆盖行')
  assert.match(txt, /serverName: exa/, '原配置行不能删')

  const again = setMcpEnabled(patch, 'mcp-exa', true, { apply: true })
  assert.equal(again.applied, true, again.error)
  assert.equal(getMcp(patch, 'mcp-exa').enabled, true)
})

test('validateAll 对 fixture 报告合法', (t) => {
  const { patch } = setup(t)
  const v = validateAll(patch)
  assert.equal(v.valid, true, v.errors.join('；'))
  assert.equal(v.count, 3)
})
