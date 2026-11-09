#!/usr/bin/env node
/**
 * dsh-admin CLI —— 默认只读，任何写操作必须显式 --apply。
 *
 * 全局参数：--dsh-home <path> --profile <name> --json --dry-run --apply --yes
 * 命令见 usage()。所有路径默认锚定在 --dsh-home 内，绝不默认写真实 ~/.dsh。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VERSION, getDshHome, getPatchPath, getSkillsDir, resolveSkillRoots, DEFAULT_PROFILE,
  listMcp, getMcp, addMcp, updateMcp, removeMcp, setMcpEnabled, validateAll,
  listSkills, getSkill, createSkill, setSkillEnabled, removeSkill, exportSkills, importSkills
} from '../lib/index.mjs'

const BOOL_FLAGS = new Set(['json', 'dry-run', 'apply', 'yes'])
const MULTI_FLAGS = new Set(['args', 'env', 'headers', 'extra-root'])

function parseArgv(argv) {
  const out = { _: [] }
  let i = 0
  while (i < argv.length) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const key = t.slice(2, eq >= 0 ? eq : undefined)
      const inline = eq >= 0 ? t.slice(eq + 1) : undefined
      if (BOOL_FLAGS.has(key)) { out[key] = true; i++; continue }
      const vals = []
      if (inline !== undefined) vals.push(inline)
      i++
      if (MULTI_FLAGS.has(key)) {
        while (i < argv.length && !argv[i].startsWith('--')) vals.push(argv[i++])
      } else if (inline === undefined && i < argv.length && !argv[i].startsWith('--')) {
        vals.push(argv[i++])
      }
      out[key] = out[key] === undefined ? vals : out[key].concat(vals)
      continue
    }
    out._.push(t)
    i++
  }
  return out
}

const first = (v) => (v === undefined ? undefined : (Array.isArray(v) ? v[0] : v))
const arr = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]))
function parseKV(v) {
  const o = {}
  for (const s of arr(v)) {
    const str = String(s)
    const k = str.indexOf('=')
    if (k < 0) o[str] = ''
    else o[str.slice(0, k)] = str.slice(k + 1)
  }
  return o
}

const USAGE = `dsh-admin ${VERSION} —— DSH 的 MCP + skills 管理套件（默认只读）

用法: dsh-admin <命令> [参数] [全局参数]

全局参数:
  --dsh-home <path>   指定 DSH 主目录（默认 env DSH_HOME 或 ~/.dsh）
  --profile <name>    指定 profile（默认 ${DEFAULT_PROFILE}）
  --json              以 JSON 输出
  --dry-run           强制只预览 diff（默认即只读）
  --apply             真正写入（默认不写！写操作必须带它）
  --yes               非交互（本工具无交互确认，保留兼容）
  --project-root <p>  skills 扫描的项目根（默认锚定在 dsh-home 内）
  --agents-home <p>   skills 扫描的 agents 主目录（默认锚定在 dsh-home 内）
  --extra-root <p>    追加一个 skill root（可多次）

skills 子命令:
  list                                 列出 skills
  show <name>                          查看详情
  enable <name> | disable <name>       启停（改 frontmatter）
  create <name> --description "..." [--when-to-use "..."]
  remove <name>                        移到备份目录
  export <file> | import <file>        JSON 导出 / 导入

mcp 子命令:
  list | show <id> | validate
  add --id <id> --name <serverName> --transport stdio|streamable-http
      [--command <cmd> --args <a> <b> ...] [--url <url>]
      [--env K=V ...] [--headers K=V ...] [--tool-timeout N] [--cwd <p>]
  update <id> <同上可选参数>
  remove <id> | enable <id> | disable <id>

  status                               打印 DSH_HOME/profile/MCP 数/skills 数/roots
`

function usage() { return USAGE }

/** 供测试/复用：判断当前是否允许写入 */
export function writeMode(flags) {
  return flags.apply === true && flags['dry-run'] !== true
}

function buildSkillOpts(dshHome, flags) {
  return {
    projectRoot: first(flags['project-root']) || dshHome,
    agentsHome: first(flags['agents-home']) || dshHome,
    extraRoots: arr(flags['extra-root']).map(String)
  }
}

function buildMcpEntryFromFlags(flags, idOverride) {
  const e = {
    id: idOverride || first(flags.id),
    serverName: first(flags.name),
    transport: first(flags.transport)
  }
  if (flags.command !== undefined) e.command = first(flags.command)
  if (flags.args !== undefined) e.args = arr(flags.args)
  if (flags.url !== undefined) e.url = first(flags.url)
  if (flags.env !== undefined) e.env = parseKV(flags.env)
  if (flags.headers !== undefined) e.headers = parseKV(flags.headers)
  if (flags['tool-timeout'] !== undefined) e.toolCallTimeoutMs = first(flags['tool-timeout'])
  if (flags.cwd !== undefined) e.cwd = first(flags.cwd)
  return e
}

function buildMcpPatchFromFlags(flags) {
  const p = buildMcpEntryFromFlags(flags)
  delete p.id
  return p
}

let FLAGS = {}
let APPLY = false
let EXIT = 0

function fail(msg, code = 1) {
  if (FLAGS.json) console.log(JSON.stringify({ ok: false, error: String(msg) }))
  else console.error('错误: ' + String(msg))
  EXIT = code
}

function emit(data, human) {
  if (FLAGS.json) console.log(JSON.stringify(data, null, 2))
  else console.log(human)
}

function pickResult(r) {
  return { applied: !!r.applied, changed: !!r.changed, diff: r.diff || '', backupPath: r.backupPath || null, error: r.error || null }
}

/** 处理一次写操作：打印 diff / 结果，dry-run 退出码 0 */
function handleWrite(r, okMsg) {
  if (r.error) { fail(r.error); return }
  if (FLAGS.json) { console.log(JSON.stringify(pickResult(r), null, 2)); return }
  console.log(r.applied ? okMsg : '[dry-run] 未写入（加 --apply 才会真正落盘）')
  if (r.diff) console.log(r.diff)
  if (r.backupPath) console.log('备份: ' + r.backupPath)
}

function fmtEnabled(v) { return v ? '启用' : '停用' }

function fmtMcpTable(list) {
  if (!list.length) return '(无 MCP)'
  const w = [20, 18, 17, 8, 40]
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ')
  const rows = list.map((e) => [
    e.id, e.serverName, e.transport || '-', fmtEnabled(e.enabled), e.command || e.url || '-'
  ])
  return [
    line(['ID', 'SERVERNAME', 'TRANSPORT', '状态', 'COMMAND / URL']),
    '-'.repeat(110),
    ...rows.map((r) => line(r))
  ].join('\n')
}

function fmtSkillsTable(list) {
  if (!list.length) return '(无 skills)'
  const lines = []
  for (const s of list) {
    lines.push(`${s.shadowed ? '·' : '●'} ${s.name}  [rank ${s.rank} / ${s.source}]  模型可调用:${fmtEnabled(s.modelInvocable)}  用户可调用:${fmtEnabled(s.userInvocable)}${s.shadowed ? '  (被遮蔽)' : ''}`)
    lines.push(`    ${s.description.slice(0, 90)}`)
    lines.push(`    ${s.path}`)
  }
  return lines.join('\n')
}

export function main(argv = process.argv.slice(2)) {
  const flags = parseArgv(argv)
  FLAGS = flags
  APPLY = writeMode(flags)
  const dshHome = path.resolve(first(flags['dsh-home']) || getDshHome())
  const profile = first(flags.profile) || DEFAULT_PROFILE
  const patchPath = getPatchPath(dshHome, profile)
  const skillOpts = buildSkillOpts(dshHome, flags)
  const cmd = flags._[0]
  const sub = flags._[1]
  const arg2 = flags._[2]

  if (!cmd || cmd === 'help' || flags.help) { emit({ usage: usage() }, usage()); return 0 }

  try {
    // ---------------- status ----------------
    if (cmd === 'status') {
      const mcp = listMcp(patchPath)
      const skills = listSkills(dshHome, skillOpts)
      const roots = resolveSkillRoots(dshHome, skillOpts).map((r) => ({
        rank: r.rank, source: r.source, path: r.path, exists: fs.existsSync(r.path)
      }))
      const data = {
        version: VERSION, dshHome, profile, patchPath, patchExists: fs.existsSync(patchPath),
        skillsDir: getSkillsDir(dshHome), mcpCount: mcp.length, skillsCount: skills.length, roots
      }
      emit(data, [
        `dsh-admin ${VERSION}`,
        `DSH_HOME : ${dshHome}`,
        `profile  : ${profile}`,
        `patch    : ${patchPath} (${data.patchExists ? '存在' : '不存在'})`,
        `MCP      : ${mcp.length} 条`,
        `skills   : ${skills.length} 个`,
        `skills roots:`,
        ...roots.map((r) => `  [${r.rank}] ${r.path} ${r.exists ? '' : '(不存在)'}`)
      ].join('\n'))
      return 0
    }

    // ---------------- mcp ----------------
    if (cmd === 'mcp') {
      if (sub === 'list' || !sub) {
        const list = listMcp(patchPath)
        emit(list, fmtMcpTable(list))
        return 0
      }
      if (sub === 'show') {
        if (!arg2) throw new Error('用法: mcp show <id>')
        const e = getMcp(patchPath, arg2)
        if (!e) throw new Error(`找不到 MCP: ${arg2}`)
        emit(e, `${e.id}\n  serverName : ${e.serverName}\n  transport  : ${e.transport}\n  enabled    : ${fmtEnabled(e.enabled)}\n  command    : ${e.command || '-'}\n  url         : ${e.url || '-'}\n  args        : ${JSON.stringify(e.args)}\n  env         : ${JSON.stringify(e.env)}\n  headers     : ${JSON.stringify(e.headers)}\n  timeout     : ${e.toolCallTimeoutMs ?? '-'}\n  path        : ${patchPath}`)
        return 0
      }
      if (sub === 'validate') {
        const v = validateAll(patchPath)
        emit(v, v.valid
          ? `校验通过：${v.count} 条 MCP 配置均合法、无重复 id/serverName`
          : `校验失败：\n` + v.errors.map((e) => '  - ' + e).join('\n'))
        if (!v.valid) EXIT = 1
        return 0
      }
      if (sub === 'add') {
        const entry = buildMcpEntryFromFlags(flags)
        if (!entry.id) throw new Error('add 需要 --id')
        handleWrite(addMcp(patchPath, entry, { apply: APPLY }), `已新增 MCP: ${entry.id}`)
        return 0
      }
      if (sub === 'update') {
        if (!arg2) throw new Error('用法: mcp update <id> [参数]')
        handleWrite(updateMcp(patchPath, arg2, buildMcpPatchFromFlags(flags), { apply: APPLY }), `已更新 MCP: ${arg2}`)
        return 0
      }
      if (sub === 'remove') {
        if (!arg2) throw new Error('用法: mcp remove <id>')
        handleWrite(removeMcp(patchPath, arg2, { apply: APPLY }), `已删除 MCP: ${arg2}`)
        return 0
      }
      if (sub === 'enable' || sub === 'disable') {
        if (!arg2) throw new Error(`用法: mcp ${sub} <id>`)
        handleWrite(setMcpEnabled(patchPath, arg2, sub === 'enable', { apply: APPLY }), `已${sub === 'enable' ? '启用' : '停用'} MCP: ${arg2}`)
        return 0
      }
      throw new Error(`未知 mcp 子命令: ${sub}`)
    }

    // ---------------- skills ----------------
    if (cmd === 'skills') {
      if (sub === 'list' || !sub) {
        const list = listSkills(dshHome, skillOpts)
        emit(list, fmtSkillsTable(list))
        return 0
      }
      if (sub === 'show') {
        if (!arg2) throw new Error('用法: skills show <name>')
        const s = getSkill(dshHome, arg2, skillOpts)
        if (!s) throw new Error(`找不到 skill: ${arg2}`)
        emit(s, [
          `${s.name}  [rank ${s.rank} / ${s.source}]`,
          `  description : ${s.description}`,
          `  whenToUse   : ${s.whenToUse || '-'}`,
          `  模型可调用  : ${fmtEnabled(s.modelInvocable)}`,
          `  用户可调用  : ${fmtEnabled(s.userInvocable)}`,
          `  path        : ${s.path}`,
          '', '--- frontmatter ---', s.rawFrontmatter.trimEnd(), '--- 正文(前 20 行) ---',
          ...String(s.body).split('\n').slice(0, 20)
        ].join('\n'))
        return 0
      }
      if (sub === 'enable' || sub === 'disable') {
        if (!arg2) throw new Error(`用法: skills ${sub} <name>`)
        handleWrite(setSkillEnabled(dshHome, arg2, sub === 'enable', { apply: APPLY, ...skillOpts }), `已${sub === 'enable' ? '启用' : '停用'} skill: ${arg2}`)
        return 0
      }
      if (sub === 'create') {
        if (!arg2) throw new Error('用法: skills create <name> --description "..."')
        handleWrite(createSkill(dshHome, arg2, {
          description: first(flags.description) || '',
          whenToUse: first(flags['when-to-use']),
          apply: APPLY, ...skillOpts
        }), `已创建 skill: ${arg2}`)
        return 0
      }
      if (sub === 'remove') {
        if (!arg2) throw new Error('用法: skills remove <name>')
        handleWrite(removeSkill(dshHome, arg2, { apply: APPLY, ...skillOpts }), `已移除 skill: ${arg2}`)
        return 0
      }
      if (sub === 'export') {
        if (!arg2) throw new Error('用法: skills export <file>')
        const exp = exportSkills(dshHome, skillOpts)
        if (APPLY) {
          fs.mkdirSync(path.dirname(path.resolve(arg2)), { recursive: true })
          fs.writeFileSync(path.resolve(arg2), JSON.stringify(exp, null, 2), 'utf8')
          emit({ applied: true, file: path.resolve(arg2), count: exp.skills.length }, `已导出 ${exp.skills.length} 个 skill 到 ${path.resolve(arg2)}`)
        } else {
          emit(exp, `[dry-run] 将导出 ${exp.skills.length} 个 skill 到 ${arg2}（加 --apply 写文件）\n` + JSON.stringify(exp, null, 2).slice(0, 1200))
        }
        return 0
      }
      if (sub === 'import') {
        if (!arg2) throw new Error('用法: skills import <file>')
        const abs = path.resolve(arg2)
        if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${abs}`)
        const text = fs.readFileSync(abs, 'utf8')
        handleWrite(importSkills(dshHome, text, { apply: APPLY, ...skillOpts }), `已导入 skills 自 ${abs}`)
        return 0
      }
      throw new Error(`未知 skills 子命令: ${sub}`)
    }

    throw new Error(`未知命令: ${cmd}（用 help 查看用法）`)
  } catch (e) {
    fail(e?.message || String(e))
    return 0
  }
}

// 直接运行时才执行；被 import 时只导出函数（便于单测）
// 用 fileURLToPath 而非 URL.pathname：Windows 中文路径会被百分号编码，直接比较会失败
const selfPath = fileURLToPath(import.meta.url)
const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(selfPath)
if (isDirect || process.env.DSH_ADMIN_CLI_RUN === '1') {
  main()
  process.exitCode = EXIT
}
