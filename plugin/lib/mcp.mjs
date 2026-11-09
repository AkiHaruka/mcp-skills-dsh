/**
 * MCP 配置 CRUD（操作 profile 的 cordis.patch.yml）。
 *
 * 识别两类条目：
 *  1) '@deepseek-ai/dsh-mcp-client' 静态行（既可在 `- insert:` 块内，也可作为顶层 `- id:` 行），
 *     config 里有 serverName / transport / command|url / args / env / headers / ...
 *  2) '@deepseek-ai/dsh-mcp-manager' 的 config.servers volatile dict，
 *     dict 的每个 key 视作一条 MCP（key 即默认 serverName）。
 *
 * 启停机制：不删原配置，用顶层 `- id: <id>` + `disabled: true` 覆盖行来禁用；
 * 启用时移除该覆盖行（cordis patch 中后出现的同 id 行覆盖前面的）。
 *
 * 写入：默认 dry-run（只返回 diff）；--apply 时才落盘，落盘统一走 yaml-io.commitFile
 * （原子写 + 自动备份 + 失败回滚 + 解析回读一致校验），且全程在 AST 上修改以保留
 * 注释 / 顺序 / 单引号 / !!js 节点。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  parseDoc, docToJS, docToString, getNodeAt, setMapValue,
  createNode, isMap, isSeq, commitFile
} from './yaml-io.mjs'

export const CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'
export const MANAGER_NAME = '@deepseek-ai/dsh-mcp-manager'
export const SERVERNAME_RE = /^[A-Za-z0-9_-]{1,32}$/
export const TRANSPORTS = ['stdio', 'streamable-http']

const CONFIG_KEYS = [
  'serverName', 'transport', 'command', 'url', 'args', 'env',
  'headers', 'toolCallTimeoutMs', 'cwd', 'failOnStartupError'
]

function isMcpConfigLine(item) {
  return !!item && (item.name === CLIENT_NAME || item.name === MANAGER_NAME) && !!item.config
}

function makeEntry(node, loc, kind, forcedId, configLocOverride) {
  const cfg = (node && node.config && typeof node.config === 'object') ? node.config : {}
  const id = String(forcedId || node?.id || cfg.serverName || '(unknown)')
  const serverName = String(cfg.serverName || forcedId || id)
  return {
    id,
    serverName,
    transport: cfg.transport ?? null,
    command: cfg.command ?? null,
    url: cfg.url ?? null,
    args: Array.isArray(cfg.args) ? cfg.args.slice() : [],
    env: (cfg.env && typeof cfg.env === 'object') ? { ...cfg.env } : {},
    headers: (cfg.headers && typeof cfg.headers === 'object') ? { ...cfg.headers } : {},
    toolCallTimeoutMs: cfg.toolCallTimeoutMs ?? null,
    cwd: cfg.cwd ?? null,
    enabled: true,
    raw: {
      config: { ...cfg },
      node,
      loc,
      configLoc: configLocOverride || loc.concat(['config']),
      kind
    }
  }
}

function collectServers(servers, baseLoc, entries) {
  if (!servers || typeof servers !== 'object') return
  const keys = Array.isArray(servers) ? servers.map((_, i) => i) : Object.keys(servers)
  for (const key of keys) {
    const v = servers[key]
    const cfg = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
    const merged = { serverName: cfg.serverName || String(key), ...cfg }
    const loc = baseLoc.concat([key])
    entries.push(makeEntry({ id: String(key), config: merged }, loc, 'manager', String(key), loc))
  }
}

/** 扫描一个已解析 Document，返回所有 MCP 条目 + 禁用覆盖行信息 */
function collect(doc) {
  const data = docToJS(doc)
  const seq = Array.isArray(data) ? data : []
  const entries = []
  const disabledIds = new Set()
  const disabledOverrideIdx = []

  for (let i = 0; i < seq.length; i++) {
    const item = seq[i]
    if (!item || typeof item !== 'object') continue

    if (Array.isArray(item.insert)) {
      for (let j = 0; j < item.insert.length; j++) {
        const sub = item.insert[j]
        if (!sub || typeof sub !== 'object') continue
        if (sub.name === CLIENT_NAME && sub.config) {
          entries.push(makeEntry(sub, [i, 'insert', j], 'client'))
        } else if (sub.name === MANAGER_NAME && sub.config) {
          collectServers(sub.config.servers, [i, 'insert', j, 'config', 'servers'], entries)
        }
      }
    }

    if (isMcpConfigLine(item)) {
      if (item.name === CLIENT_NAME) entries.push(makeEntry(item, [i], 'client'))
      else collectServers(item.config.servers, [i, 'config', 'servers'], entries)
      if (item.disabled === true) disabledIds.add(String(item.id || item.config?.serverName || ''))
    } else if (item && item.id && item.disabled === true) {
      // 顶层禁用覆盖行（cordis 用后出现的同 id 行覆盖）
      disabledIds.add(String(item.id))
      disabledOverrideIdx.push(i)
    }
  }

  for (const e of entries) e.enabled = !disabledIds.has(e.id)
  return { entries, disabledIds, disabledOverrideIdx, seq }
}

function loadPatch(patchPath) {
  const abs = path.resolve(String(patchPath))
  const content = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '[]\n'
  return { abs, content, doc: parseDoc(content) }
}

/** 通用变更流程：加载 → 校验/改 AST → 生成新内容 → 提交（可 dry-run） */
function mutate(patchPath, fn, opts = {}) {
  const { abs, doc } = loadPatch(patchPath)
  if (!isSeq(doc.contents)) throw new Error('cordis.patch.yml 顶层不是 YAML 序列')
  const ctx = collect(doc)
  fn(doc, ctx)
  const newContent = docToString(doc)
  const verify = (txt) => {
    const d2 = parseDoc(txt)
    if (d2.errors.length) throw new Error('回读 YAML 有语法错误')
    if (typeof opts.verifyData === 'function') opts.verifyData(collect(d2))
  }
  const res = commitFile(abs, newContent, { apply: !!opts.apply, verify })
  return { ...res, content: newContent }
}

function assertOk(result) {
  if (result.error) throw new Error(result.error)
}

/**
 * 校验一条 MCP 配置。
 * @param {object} entry
 * @param {Array} existing 现有条目（用于重复检测）
 * @param {object} opts { excludeId } update 时排除自身
 * @returns {{valid:boolean, errors:string[]}}
 */
export function validateMcpEntry(entry, existing = [], opts = {}) {
  const errors = []
  const id = String(entry?.id ?? '').trim()
  const serverName = String(entry?.serverName ?? '').trim()
  const transport = entry?.transport

  if (!id) errors.push('缺少 id')
  else if (id.includes('..') || /[\/\\]/.test(id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    errors.push('id 非法（只能是字母数字 . _ -，且不能以分隔符开头）')
  }
  if (!SERVERNAME_RE.test(serverName)) errors.push(`serverName 非法（需匹配 ${SERVERNAME_RE}）`)
  if (!TRANSPORTS.includes(transport)) errors.push(`transport 非法（只能是 ${TRANSPORTS.join(' | ')}）`)
  if (transport === 'stdio' && !String(entry?.command ?? '').trim()) errors.push('stdio 必须提供 command')
  if (transport === 'streamable-http' && !String(entry?.url ?? '').trim()) errors.push('streamable-http 必须提供 url')

  const others = existing.filter((e) => e.id !== opts.excludeId)
  if (id && others.some((e) => e.id === id)) errors.push(`重复 id: ${id}`)
  if (serverName && others.some((e) => e.serverName === serverName)) errors.push(`重复 serverName: ${serverName}`)

  return { valid: errors.length === 0, errors }
}

/** 列出所有 MCP */
export function listMcp(patchPath) {
  const { doc } = loadPatch(patchPath)
  return collect(doc).entries
}

export function getMcp(patchPath, id) {
  return listMcp(patchPath).find((e) => e.id === id) || null
}

function buildClientConfig(entry) {
  const config = { serverName: entry.serverName, transport: entry.transport }
  if (entry.transport === 'stdio') {
    config.command = entry.command
    if (entry.args && entry.args.length) config.args = entry.args
    if (entry.cwd) config.cwd = entry.cwd
  } else {
    config.url = entry.url
  }
  if (entry.env && Object.keys(entry.env).length) config.env = entry.env
  if (entry.headers && Object.keys(entry.headers).length) config.headers = entry.headers
  if (entry.toolCallTimeoutMs !== undefined && entry.toolCallTimeoutMs !== null && entry.toolCallTimeoutMs !== '') {
    config.toolCallTimeoutMs = Number(entry.toolCallTimeoutMs)
  }
  return config
}

/** 新增一条 MCP（追加一个新的 - insert: 块，保持原有内容不动） */
export function addMcp(patchPath, entry, opts = {}) {
  const normalized = {
    id: entry.id,
    serverName: entry.serverName || entry.id,
    transport: entry.transport,
    command: entry.command,
    url: entry.url,
    args: entry.args || [],
    env: entry.env || {},
    headers: entry.headers || {},
    toolCallTimeoutMs: entry.toolCallTimeoutMs,
    cwd: entry.cwd
  }
  return mutate(patchPath, (doc, ctx) => {
    const v = validateMcpEntry(normalized, ctx.entries)
    if (!v.valid) throw new Error('校验失败：' + v.errors.join('；'))
    const item = { insert: [{ id: normalized.id, name: CLIENT_NAME, config: buildClientConfig(normalized) }] }
    doc.contents.items.push(createNode(doc, item))
  }, {
    apply: opts.apply,
    verifyData: (c2) => {
      if (!c2.entries.some((e) => e.id === normalized.id)) throw new Error('回读未找到新增的 MCP')
    }
  })
}

/** 更新一条 MCP（逐字段修改 config，保留其他字段与 !!js 节点） */
export function updateMcp(patchPath, id, patch, opts = {}) {
  return mutate(patchPath, (doc, ctx) => {
    const entry = ctx.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`找不到 MCP: ${id}`)
    const merged = {
      id,
      serverName: patch.serverName ?? entry.serverName,
      transport: patch.transport ?? entry.transport,
      command: patch.command ?? entry.command,
      url: patch.url ?? entry.url,
      args: patch.args ?? entry.args,
      env: patch.env ?? entry.env,
      headers: patch.headers ?? entry.headers,
      toolCallTimeoutMs: patch.toolCallTimeoutMs ?? entry.toolCallTimeoutMs,
      cwd: patch.cwd ?? entry.cwd
    }
    const v = validateMcpEntry(merged, ctx.entries, { excludeId: id })
    if (!v.valid) throw new Error('校验失败：' + v.errors.join('；'))

    const sets = {}
    const dels = []
    for (const k of CONFIG_KEYS) {
      if (k in patch && patch[k] !== undefined) sets[k] = patch[k]
    }
    // transport 切换时清理互斥字段
    if (patch.transport === 'streamable-http') {
      for (const k of ['command', 'args', 'cwd']) { dels.push(k); delete sets[k] }
    } else if (patch.transport === 'stdio') {
      for (const k of ['url', 'headers']) { dels.push(k); delete sets[k] }
    }

    const cfgNode = getNodeAt(doc, entry.raw.configLoc)
    if (!isMap(cfgNode)) throw new Error('config 节点定位失败')
    for (const k of dels) if (cfgNode.has(k)) cfgNode.delete(k)
    for (const [k, val] of Object.entries(sets)) {
      if (val === null || val === undefined) { if (cfgNode.has(k)) cfgNode.delete(k); continue }
      setMapValue(doc, cfgNode, k, val)
    }
  }, {
    apply: opts.apply,
    verifyData: (c2) => {
      if (!c2.entries.some((e) => e.id === id)) throw new Error('回读未找到更新后的 MCP')
    }
  })
}

/** 删除一条 MCP（同时删除其 disabled 覆盖行） */
export function removeMcp(patchPath, id, opts = {}) {
  return mutate(patchPath, (doc, ctx) => {
    const entry = ctx.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`找不到 MCP: ${id}`)
    const loc = entry.raw.loc

    // 先删覆盖行（倒序，避免索引偏移）
    const overrideIdx = ctx.disabledOverrideIdx
      .filter((idx) => String(ctx.seq[idx]?.id) === id)
      .sort((a, b) => b - a)
    for (const idx of overrideIdx) doc.contents.items.splice(idx, 1)

    // 重新计算 loc（删除覆盖行后，若 loc 的顶层索引在删除点之后需前移）
    let top = loc[0]
    const shift = overrideIdx.filter((idx) => idx < top).length
    top -= shift
    const fixedLoc = [top, ...loc.slice(1)]

    if (entry.raw.kind === 'manager') {
      const parent = getNodeAt(doc, fixedLoc.slice(0, -1))
      if (isMap(parent)) parent.delete(fixedLoc[fixedLoc.length - 1])
    } else if (fixedLoc.length === 1) {
      doc.contents.items.splice(top, 1)
    } else {
      // [i, 'insert', j]
      const insertSeq = getNodeAt(doc, fixedLoc.slice(0, -1))
      if (isSeq(insertSeq)) {
        insertSeq.items.splice(fixedLoc[fixedLoc.length - 1], 1)
        if (insertSeq.items.length === 0) doc.contents.items.splice(top, 1)
      }
    }
  }, {
    apply: opts.apply,
    verifyData: (c2) => {
      if (c2.entries.some((e) => e.id === id)) throw new Error('回读仍能找到已删除的 MCP')
    }
  })
}

/** 启停：禁用=追加 disabled:true 覆盖行；启用=删除覆盖行 */
export function setMcpEnabled(patchPath, id, enabled, opts = {}) {
  return mutate(patchPath, (doc, ctx) => {
    const entry = ctx.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`找不到 MCP: ${id}`)
    const want = !!enabled
    const overrideIdx = ctx.disabledOverrideIdx
      .filter((idx) => String(ctx.seq[idx]?.id) === id)

    if (!want) {
      // 禁用：无覆盖行则追加 - id: <id>  disabled: true
      if (overrideIdx.length === 0) {
        doc.contents.items.push(createNode(doc, { id, disabled: true }))
      }
    } else {
      // 启用：删除覆盖行（倒序）
      for (const idx of overrideIdx.sort((a, b) => b - a)) doc.contents.items.splice(idx, 1)
      // 行自身若带 disabled:true 也清掉
      if (entry.raw.node && entry.raw.node.disabled === true) {
        const node = getNodeAt(doc, entry.raw.loc)
        if (isMap(node) && node.has('disabled')) node.delete('disabled')
      }
    }
  }, {
    apply: opts.apply,
    verifyData: (c2) => {
      const e2 = c2.entries.find((e) => e.id === id)
      if (!e2) throw new Error('回读未找到该 MCP')
      if (e2.enabled !== !!enabled) throw new Error('回读启停状态与预期不一致')
    }
  })
}

/** CLI `validate` 命令：校验现有全部条目是否有重复/非法 */
export function validateAll(patchPath) {
  const entries = listMcp(patchPath)
  const errors = []
  const seenId = new Set()
  const seenName = new Set()
  for (const e of entries) {
    const v = validateMcpEntry(e, [])
    for (const msg of v.errors) if (!/重复 id|重复 serverName/.test(msg)) errors.push(`[${e.id}] ${msg}`)
    if (seenId.has(e.id)) errors.push(`重复 id: ${e.id}`)
    if (seenName.has(e.serverName)) errors.push(`重复 serverName: ${e.serverName}`)
    seenId.add(e.id)
    seenName.add(e.serverName)
  }
  return { valid: errors.length === 0, errors, count: entries.length }
}

export { assertOk }
