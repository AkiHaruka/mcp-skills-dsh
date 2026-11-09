import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listMcp } from '../lib/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FIX = path.resolve(HERE, 'fixtures')
const CLI = path.join(ROOT, 'bin', 'dsh-admin.mjs')

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-cli-'))
  const dshHome = path.join(tmp, 'home')
  fs.mkdirSync(dshHome, { recursive: true })
  copyDirSync(FIX, dshHome)
  const patch = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  return { tmp, dshHome, patch }
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT })
}

test('--json status 输出可解析 JSON', (t) => {
  const { dshHome } = setup(t)
  const r = run(['--dsh-home', dshHome, '--profile', 'desktop', '--json', 'status'])
  assert.equal(r.status, 0, r.stderr)
  const obj = JSON.parse(r.stdout)
  assert.equal(obj.version, '0.1.0')
  assert.equal(obj.mcpCount, 3)
  assert.equal(obj.skillsCount, 3)
  assert.equal(obj.patchExists, true)
  assert.ok(Array.isArray(obj.roots) && obj.roots.length >= 1)
})

test('--json mcp list 输出可解析且含 fixture 的 3 条', (t) => {
  const { dshHome } = setup(t)
  const r = run(['--dsh-home', dshHome, '--profile', 'desktop', '--json', 'mcp', 'list'])
  assert.equal(r.status, 0, r.stderr)
  const arr = JSON.parse(r.stdout)
  assert.equal(arr.length, 3)
  assert.ok(arr.some((e) => e.id === 'mcp-snowluma'))
  assert.ok(arr.some((e) => e.transport === 'streamable-http'))
})

test('--json skills list 输出可解析', (t) => {
  const { dshHome } = setup(t)
  const r = run(['--dsh-home', dshHome, '--json', 'skills', 'list'])
  assert.equal(r.status, 0, r.stderr)
  const arr = JSON.parse(r.stdout)
  assert.equal(arr.length, 3)
  assert.ok(arr.every((s) => typeof s.name === 'string' && typeof s.description === 'string'))
})

test('写操作默认只读：打印 diff、退出码 0、文件不变', (t) => {
  const { dshHome, patch } = setup(t)
  const before = fs.readFileSync(patch, 'utf8')
  const r = run(['--dsh-home', dshHome, '--profile', 'desktop',
    'mcp', 'add', '--id', 'mcp-ro', '--name', 'ro', '--transport', 'stdio', '--command', 'node'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /dry-run/)
  assert.match(r.stdout, /mcp-ro/)
  assert.equal(fs.readFileSync(patch, 'utf8'), before, '默认绝不落盘')
})

test('--json 写操作输出可解析（applied:false）', (t) => {
  const { dshHome } = setup(t)
  const r = run(['--dsh-home', dshHome, '--json', 'mcp', 'disable', 'mcp-snowluma'])
  assert.equal(r.status, 0, r.stderr)
  const obj = JSON.parse(r.stdout)
  assert.equal(obj.applied, false)
  assert.equal(obj.changed, true)
  assert.match(obj.diff, /\+/)
})

test('--apply 才真正写入并生成备份', (t) => {
  const { dshHome, patch } = setup(t)
  const before = fs.readFileSync(patch, 'utf8')
  const r = run(['--dsh-home', dshHome, '--profile', 'desktop', '--apply',
    'mcp', 'add', '--id', 'mcp-ro', '--name', 'ro', '--transport', 'stdio', '--command', 'node'])
  assert.equal(r.status, 0, r.stderr)
  assert.notEqual(fs.readFileSync(patch, 'utf8'), before)
  assert.equal(listMcp(patch).length, 4)
  const baks = fs.readdirSync(path.dirname(patch)).filter((f) => /^cordis\.patch\.yml\.bak-\d{8}-\d{6}$/.test(f))
  assert.ok(baks.length >= 1, '应生成 .bak- 备份')
  assert.match(fs.readFileSync(patch, 'utf8'), /beforeHook: !!js \|/, '!!js 保留')
})

test('--dry-run 即使带 --apply 也不写入', (t) => {
  const { dshHome, patch } = setup(t)
  const before = fs.readFileSync(patch, 'utf8')
  const r = run(['--dsh-home', dshHome, '--apply', '--dry-run',
    'mcp', 'add', '--id', 'mcp-x', '--name', 'x', '--transport', 'stdio', '--command', 'node'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.readFileSync(patch, 'utf8'), before)
})

test('校验失败（重复 id）退出码非 0 且不写入', (t) => {
  const { dshHome, patch } = setup(t)
  const before = fs.readFileSync(patch, 'utf8')
  const r = run(['--dsh-home', dshHome, '--apply',
    'mcp', 'add', '--id', 'mcp-exa', '--name', 'dup', '--transport', 'stdio', '--command', 'node'])
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /重复 id/)
  assert.equal(fs.readFileSync(patch, 'utf8'), before)
})

test('mcp list 人类可读输出包含 fixture 条目', (t) => {
  const { dshHome } = setup(t)
  const r = run(['--dsh-home', dshHome, '--profile', 'desktop', 'mcp', 'list'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /mcp-snowluma/)
  assert.match(r.stdout, /streamable-http/)
  assert.match(r.stdout, /停用/)
})
