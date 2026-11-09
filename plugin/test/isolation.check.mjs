/**
 * 隔离目录自包含导入检查（不依赖项目根 lib、不依赖任何 node_modules）。
 *
 * 做法：把 plugin/ 的发布文件单独复制到一个全新临时目录（该目录内没有
 * node_modules，也没有仓库根 lib/），再在其中放一个 check.mjs 并用独立的
 * node 子进程 `import('./lib/index.mjs')`，调用 listMcp / listSkills 指向
 * 原始 test/fixtures（仅作为数据），断言 mcpCount=3 / skillsCount=3。
 *
 * 运行：node plugin/test/isolation.check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-isolated-'))
const isolated = path.join(tmp, 'isolated-plugin')
fs.mkdirSync(isolated, { recursive: true })

// 只复制「发布文件」，明确排除 test/，绝不复制项目根 lib/ 或任何 node_modules。
const publish = ['index.js', 'host-api.js', 'runtime.js', 'client.js', 'package.json', 'cordis.patch.yml', 'README.md', 'lib', 'vendor', 'locale']
for (const name of publish) {
  const src = path.join(PLUGIN, name)
  const st = fs.statSync(src)
  if (st.isDirectory()) copyDirSync(src, path.join(isolated, name))
  else fs.copyFileSync(src, path.join(isolated, name))
}

// —— 隔离性核对 ——
const topEntries = fs.readdirSync(isolated).sort()
const hasNodeModules = (function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules') return true
    if (ent.isDirectory() && walk(path.join(dir, ent.name))) return true
  }
  return false
})(isolated)
const pkg = JSON.parse(fs.readFileSync(path.join(isolated, 'package.json'), 'utf8'))

console.log('隔离目录       :', isolated)
console.log('顶层条目       :', topEntries.join(', '))
console.log('含 node_modules:', hasNodeModules)
console.log('含仓库根 lib   :', fs.existsSync(path.join(isolated, '..', 'lib')))
console.log('package.deps   :', JSON.stringify(pkg.dependencies))
console.log('lib 文件       :', fs.readdirSync(path.join(isolated, 'lib')).filter((f) => f.endsWith('.mjs')).sort().join(', '))
console.log('vendor 入口    :', fs.existsSync(path.join(isolated, 'vendor', 'yaml', 'index.mjs')))
console.log('fixtures(数据) :', FIX)

// 写入到隔离目录内的检查脚本；其 `./lib/index.mjs` 相对该脚本自身解析。
const checkFile = path.join(isolated, 'check.mjs')
fs.writeFileSync(checkFile, `
import * as lib from './lib/index.mjs'
const FIX = process.env.DSH_FIX
const patch = FIX + '/profiles/desktop/cordis.patch.yml'
const mcp = lib.listMcp(patch)
const skills = lib.listSkills(FIX, { projectRoot: FIX, agentsHome: FIX })
console.log('mcpCount    =', mcp.length, '=>', mcp.map(e => e.id).join(', '))
console.log('skillsCount =', skills.length, '=>', skills.map(s => s.name).join(', '))
console.log('VERSION     =', lib.VERSION)
if (mcp.length !== 3 || skills.length !== 3) {
  console.error('FAIL: 期望 mcpCount=3 skillsCount=3')
  process.exit(1)
}
console.log('ISOLATED OK: 自包含导入成功（无项目根 lib、无 node_modules）')
`, 'utf8')

const r = spawnSync(process.execPath, [checkFile], {
  encoding: 'utf8',
  cwd: isolated,
  env: { ...process.env, DSH_FIX: FIX, NODE_PATH: '' }
})

process.stdout.write(r.stdout || '')
if (r.stderr) process.stderr.write(r.stderr)

// 清理
fs.rmSync(tmp, { recursive: true, force: true })

if (r.status !== 0 || hasNodeModules) {
  console.error('隔离检查失败：status=' + r.status + ' hasNodeModules=' + hasNodeModules)
  process.exit(1)
}
