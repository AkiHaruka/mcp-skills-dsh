/**
 * 路径解析：一律返回绝对路径。
 *
 * 设计要点：
 *  - DSH_HOME 优先取 env.DSH_HOME，其次 ~/.dsh；CLI/serve 用 --dsh-home 指向 fixture 时
 *    直接把该值作为 dshHome 传进来，不写全局 env，也不默认写真实 ~/.dsh。
 *  - skills roots 的 rank 数字越小优先级越高（与官方 skill-filesystem 一致：
 *    <project>/.dsh/skills=100 ... bundled=600）。
 */
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PROFILE = 'desktop'
export const PATCH_FILENAME = 'cordis.patch.yml'

export function toAbs(p) {
  return path.resolve(String(p))
}

/** DSH 主目录：env.DSH_HOME || ~/.dsh */
export function getDshHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(os.homedir(), '.dsh'))
}

/** 某个 profile 的目录： <dshHome>/profiles/<name> */
export function getProfileDir(dshHome, profile = DEFAULT_PROFILE) {
  return path.resolve(String(dshHome), 'profiles', String(profile || DEFAULT_PROFILE))
}

/** 某个 profile 的 cordis.patch.yml 绝对路径 */
export function getPatchPath(dshHome, profile = DEFAULT_PROFILE) {
  return path.join(getProfileDir(dshHome, profile), PATCH_FILENAME)
}

/** <dshHome>/skills */
export function getSkillsDir(dshHome) {
  return path.resolve(String(dshHome), 'skills')
}

/** agents 主目录：env.AGENTS_HOME || ~/.agents */
export function getAgentsHome(env = process.env) {
  return path.resolve(env.AGENTS_HOME || path.join(os.homedir(), '.agents'))
}

/**
 * 解析所有 skills roots。
 * @param {string} dshHome
 * @param {object} [opts]
 * @param {Array<string|{path,rank?,source?,label?}>} [opts.extraRoots] 自定义 root（默认 rank 从 300 递增）
 * @param {string} [opts.projectRoot] 项目根（默认 cwd 或 env.DSH_PROJECT_ROOT）
 * @param {string} [opts.agentsHome]
 * @param {string} [opts.bundledDir]
 * @param {object} [opts.env]
 * @returns {Array<{path:string, rank:number, source:string, label:string}>} 按 rank 升序
 */
export function resolveSkillRoots(dshHome, opts = {}) {
  const {
    extraRoots = [],
    projectRoot,
    agentsHome = getAgentsHome(opts.env),
    bundledDir,
    env = process.env
  } = opts
  const roots = []
  const push = (p, rank, source, label) => {
    if (!p) return
    roots.push({ path: path.resolve(String(p)), rank, source, label })
  }

  const proj = projectRoot || env.DSH_PROJECT_ROOT || process.cwd()
  push(path.join(proj, '.dsh', 'skills'), 100, 'project-dsh', '<project>/.dsh/skills')
  push(path.join(proj, '.agents', 'skills'), 200, 'project-agents', '<project>/.agents/skills')

  let customRank = 300
  for (const r of (Array.isArray(extraRoots) ? extraRoots : [extraRoots])) {
    if (!r) continue
    if (typeof r === 'string') push(r, customRank++, 'custom', r)
    else if (r.path) {
      push(r.path, Number.isFinite(r.rank) ? r.rank : customRank++, r.source || 'custom', r.label || r.path)
    }
  }

  push(getSkillsDir(dshHome), 400, 'dshHome', '<dshHome>/skills')
  push(path.join(agentsHome, 'skills'), 500, 'agentsHome', '<agentsHome>/skills')
  if (bundledDir) push(bundledDir, 600, 'bundled', 'bundled')

  // 同一个绝对路径只保留一次，按 rank 升序
  const seen = new Set()
  return roots
    .filter((r) => {
      const k = r.path.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.rank - b.rank)
}

/** child 是否位于 parent 之内（含相等），用于防路径穿越 */
export function isWithin(child, parent) {
  const c = path.resolve(String(child))
  const p = path.resolve(String(parent))
  if (c === p) return true
  const rel = path.relative(p, c)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 断言 child 落在 roots 中任一目录内，否则抛错（防 .. 穿越） */
export function assertWithin(child, roots) {
  const c = path.resolve(String(child))
  const list = (Array.isArray(roots) ? roots : [roots])
    .map((r) => (typeof r === 'string' ? r : r && r.path))
    .filter(Boolean)
  if (!list.some((p) => isWithin(c, p))) {
    throw new Error('路径越界（不在允许的 roots 内）: ' + c)
  }
  return c
}

/** 合法的 skill / mcp 名称（kebab-case 且不含路径分隔符 / ..） */
export function isSafeName(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    !name.includes('..') &&
    !name.includes('/') &&
    !name.includes('\\')
  )
}

/** kebab-case 校验（用于 createSkill） */
export function isKebabCase(name) {
  return typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}
