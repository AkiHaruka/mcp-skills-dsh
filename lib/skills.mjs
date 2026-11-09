/**
 * Skills CRUD。
 *
 * 官方事实（docs/subsystems/skills.md）：
 *  - skill = 目录 <name>/SKILL.md 或扁平 <name>.md；
 *  - YAML frontmatter 必须 name + description，可选 whenToUse /
 *    disable-model-invocation / user-invocable；名字 kebab-case；
 *  - 没有 meta.json、没有安装/启停 API —— 启停只能改 frontmatter 或删文件。
 *
 * 核心技术选择（round-trip 保真）：
 *  - 读取用 yaml.parse() 解析 frontmatter（正确处理 > 折叠块、| 块、单双引号）。
 *  - 启停写入**不重新序列化整个 frontmatter**（那会破坏 > 块的排版），而是
 *    在「文本行」级别只替换 disable-model-invocation / user-invocable 两行，
 *    其余 frontmatter 行与 Markdown 正文按字节原样拼回。
 *  - splitFrontmatter 用正则切出 open(---) / fmText / close(---) / body，
 *    body 从不参与任何改写。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  resolveSkillRoots, getSkillsDir, isKebabCase, isSafeName
} from './paths.mjs'
import { parseYaml, commitFile, backupStamp } from './yaml-io.mjs'

const FM_RE = /^(---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*\r?(?:\n|$))/m

/** 把 SKILL.md 切成 frontmatter 段与正文；正文按字节原样保留 */
export function splitFrontmatter(content) {
  const text = String(content ?? '')
  const m = FM_RE.exec(text)
  if (!m) return { hasFrontmatter: false, open: '', fmText: '', close: '', body: text }
  return {
    hasFrontmatter: true,
    open: m[1],          // '---\n'
    fmText: m[2],        // frontmatter 内容（含末尾换行）
    close: m[3],         // '---\n' 或 '---'
    body: text.slice(m[0].length)
  }
}

/** 解析 frontmatter 文本为对象（> 折叠块会折叠成单行字符串） */
export function parseFrontmatter(fmText) {
  try {
    const v = parseYaml(fmText)
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
  } catch {
    return {}
  }
}

function detectEol(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n'
}

function yamlScalar(s) {
  return JSON.stringify(String(s ?? ''))
}

/** 在行数组里原地替换/新增/删除一个顶层 flag 行（保留其余行与块标量） */
function patchFlagLine(lines, key, value) {
  const out = lines.slice()
  let start = -1
  for (let i = 0; i < out.length; i++) {
    const m = /^([A-Za-z0-9_.-]+):/.exec(out[i])
    if (m && m[1] === key) { start = i; break }
  }
  let end = start
  if (start >= 0) {
    end = start + 1
    while (end < out.length && /^[ \t]/.test(out[end])) end++
  }
  if (value === null || value === undefined) {
    if (start >= 0) out.splice(start, end - start)
    return out
  }
  const newLine = `${key}: ${value}`
  if (start >= 0) {
    out.splice(start, end - start, newLine)
  } else {
    while (out.length && out[out.length - 1] === '') out.pop()
    out.push(newLine, '')
  }
  return out
}

/**
 * 只改指定 flag，重组出完整 SKILL.md 内容。
 * @param {string} content 原文
 * @param {Record<string, string|boolean|null>} updates key -> 值；null 表示删除该 key
 */
export function rewriteFrontmatter(content, updates) {
  const parts = splitFrontmatter(content)
  if (!parts.hasFrontmatter) {
    const eol = detectEol(content)
    const lines = [`---`]
    for (const [k, v] of Object.entries(updates)) {
      if (v !== null && v !== undefined) lines.push(`${k}: ${v}`)
    }
    lines.push('---', '')
    return lines.join(eol) + String(content)
  }
  const eol = parts.fmText.includes('\r\n') ? '\r\n' : '\n'
  let lines = parts.fmText.split(/\r?\n/)
  for (const [k, v] of Object.entries(updates)) lines = patchFlagLine(lines, k, v)
  return parts.open + lines.join(eol) + parts.close + parts.body
}

function buildSkill(root, dirName, skillPath, content) {
  const parts = splitFrontmatter(content)
  const fm = parts.hasFrontmatter ? parseFrontmatter(parts.fmText) : {}
  const desc = fm.description != null ? String(fm.description).trim() : ''
  const whenRaw = fm.whenToUse ?? fm['when-to-use'] ?? null
  return {
    name: String(fm.name || dirName),
    dirName,
    description: desc,
    whenToUse: whenRaw != null ? String(whenRaw).trim() : null,
    modelInvocable: fm['disable-model-invocation'] !== true,
    userInvocable: fm['user-invocable'] !== false,
    source: root.source,
    rootLabel: root.label,
    rank: root.rank,
    path: skillPath,
    rawFrontmatter: parts.fmText,
    shadowed: false,
    shadowedBy: null
  }
}

function scanRoot(root, out) {
  let entries
  try { entries = fs.readdirSync(root.path, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    const full = path.join(root.path, ent.name)
    let skillPath = null
    let dirName = null
    // Windows junction / symlink: Dirent reports neither isDirectory() nor isFile().
    // Follow it with statSync so linked skill bundles are still discovered.
    let isDir = ent.isDirectory()
    if (!isDir && ent.isSymbolicLink()) {
      try { isDir = fs.statSync(full).isDirectory() } catch { continue }
    }
    if (isDir) {
      if (ent.name.startsWith('.')) continue
      const p = path.join(full, 'SKILL.md')
      if (fs.existsSync(p)) { skillPath = p; dirName = ent.name }
    } else if (ent.isFile() && ent.name.endsWith('.md') && !ent.name.startsWith('.')) {
      skillPath = full
      dirName = ent.name.slice(0, -3)
    }
    if (!skillPath || !isSafeName(dirName)) continue
    let content
    try { content = fs.readFileSync(skillPath, 'utf8') } catch { continue }
    out.push(buildSkill(root, dirName, skillPath, content))
  }
}

/**
 * 列出所有 skills（按 rank 升序；重名者 rank 大的标记 shadowed）。
 * @param {string} dshHome
 * @param {Array|object} [extraRootsOrOpts] root 数组或 {extraRoots, projectRoot, ...}
 */
export function listSkills(dshHome, extraRootsOrOpts = []) {
  const opts = Array.isArray(extraRootsOrOpts)
    ? { extraRoots: extraRootsOrOpts }
    : (extraRootsOrOpts || {})
  const roots = resolveSkillRoots(dshHome, opts)
  const all = []
  for (const r of roots) scanRoot(r, all)
  all.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
  const seen = new Map()
  for (const s of all) {
    if (seen.has(s.name)) {
      s.shadowed = true
      s.shadowedBy = seen.get(s.name).path
    } else {
      seen.set(s.name, s)
    }
  }
  return all
}

/** 取单个 skill，附带完整 content / body / parts（供 show、启停使用） */
export function getSkill(dshHome, name, opts = {}) {
  const list = listSkills(dshHome, opts)
  const s = list.find((e) => e.name === name || e.dirName === name)
  if (!s) return null
  let content = ''
  try { content = fs.readFileSync(s.path, 'utf8') } catch { /* ignore */ }
  const parts = splitFrontmatter(content)
  return { ...s, content, body: parts.body, parts }
}

/** 统一的 SKILL.md 写入（frontmatter+Markdown 混合，不走纯 YAML 校验） */
function writeSkillContent(skillPath, content, opts) {
  return commitFile(skillPath, content, {
    apply: !!opts.apply,
    validateYaml: false,
    verify: (txt) => {
      const p = splitFrontmatter(txt)
      if (!p.hasFrontmatter) throw new Error('缺少 frontmatter')
      const fm = parseFrontmatter(p.fmText)
      if (!fm.name) throw new Error('frontmatter 缺少 name')
    }
  })
}

/** 新建 skill（标准 frontmatter，kebab-case 校验） */
export function createSkill(dshHome, name, opts = {}) {
  if (!isKebabCase(name)) throw new Error(`skill 名必须是 kebab-case（小写字母/数字/连字符）: ${name}`)
  const dir = path.join(getSkillsDir(dshHome), name)
  const skillPath = path.join(dir, 'SKILL.md')
  if (fs.existsSync(skillPath)) throw new Error(`skill 已存在: ${name}`)
  const lines = ['---', `name: ${name}`, `description: ${yamlScalar(opts.description || '')}`]
  if (opts.whenToUse) lines.push(`whenToUse: ${yamlScalar(opts.whenToUse)}`)
  lines.push('---', '', `# ${name}`, '', '')
  return writeSkillContent(skillPath, lines.join('\n'), opts)
}

/**
 * 启停 skill：改 frontmatter 的 disable-model-invocation / user-invocable，
 * 其余 frontmatter 与正文原样保留。
 * @param {boolean|object} enabledOrFlags true/false 或 {modelInvocable, userInvocable}
 */
export function setSkillEnabled(dshHome, name, enabledOrFlags, opts = {}) {
  const skill = getSkill(dshHome, name)
  if (!skill) throw new Error(`找不到 skill: ${name}`)
  const flags = typeof enabledOrFlags === 'boolean'
    ? { modelInvocable: enabledOrFlags, userInvocable: enabledOrFlags }
    : (enabledOrFlags || {})
  const updates = {}
  if (flags.modelInvocable !== undefined) updates['disable-model-invocation'] = !flags.modelInvocable
  if (flags.userInvocable !== undefined) updates['user-invocable'] = !!flags.userInvocable
  const content = rewriteFrontmatter(skill.content, updates)
  return writeSkillContent(skill.path, content, opts)
}

/** 删除 skill：移动到 <dshHome>/.dsh-admin-backup/skills/ 而非硬删 */
export function removeSkill(dshHome, name, opts = {}) {
  const skill = getSkill(dshHome, name)
  if (!skill) throw new Error(`找不到 skill: ${name}`)
  const isDirForm = path.basename(skill.path) === 'SKILL.md' &&
    path.basename(path.dirname(skill.path)) === skill.dirName
  const src = isDirForm ? path.dirname(skill.path) : skill.path
  const backupRoot = path.join(path.resolve(String(dshHome)), '.dsh-admin-backup', 'skills')
  const dest = path.join(backupRoot, `${skill.dirName}-${backupStamp()}${isDirForm ? '' : '.md'}`)
  const diff = `- 移除: ${src}\n+ 备份到: ${dest}`
  if (!opts.apply) return { applied: false, diff, changed: true, backupPath: null }
  try {
    fs.mkdirSync(backupRoot, { recursive: true })
    fs.renameSync(src, dest)
    return { applied: true, diff, changed: true, backupPath: dest }
  } catch (e) {
    return { applied: false, diff, changed: true, backupPath: null, error: '移除失败：' + (e?.message || String(e)) }
  }
}

/** 导出为可 JSON 序列化的对象（导出完整 content 以保真 round-trip） */
export function exportSkills(dshHome, opts = {}) {
  const list = listSkills(dshHome, opts)
  return {
    format: 'dsh-admin-skills/1',
    exportedAt: new Date().toISOString(),
    skills: list.map((s) => {
      let content = ''
      try { content = fs.readFileSync(s.path, 'utf8') } catch { /* ignore */ }
      return {
        name: s.dirName,
        source: s.source,
        rank: s.rank,
        shadowed: s.shadowed,
        content
      }
    })
  }
}

/** 导入（写操作，遵守 apply/dry-run）。默认跳过被遮蔽的同名项 */
export function importSkills(dshHome, input, opts = {}) {
  let doc = input
  if (typeof input === 'string') {
    try { doc = JSON.parse(input) } catch { throw new Error('导入内容不是合法 JSON') }
  }
  if (!doc || doc.format !== 'dsh-admin-skills/1' || !Array.isArray(doc.skills)) {
    throw new Error('导入格式不识别（需要 format=dsh-admin-skills/1 与 skills 数组）')
  }
  const list = doc.skills.filter((s) => !s.shadowed)
  const results = []
  for (const s of list) {
    if (!isSafeName(s.name)) { results.push({ name: s.name, diff: '', applied: false, error: '非法名称' }); continue }
    const skillPath = path.join(getSkillsDir(dshHome), s.name, 'SKILL.md')
    const r = writeSkillContent(skillPath, String(s.content ?? ''), { apply: !!opts.apply })
    results.push({ name: s.name, ...r })
  }
  const diff = results.map((r) => `--- ${r.name} ---\n${r.diff || r.error || '（无变化）'}`).join('\n')
  const firstErr = results.find((r) => r.error)
  return {
    applied: !!opts.apply && results.some((r) => r.applied),
    diff,
    changed: true,
    backupPath: results.find((r) => r.backupPath)?.backupPath || null,
    error: firstErr ? firstErr.error : null,
    results
  }
}
