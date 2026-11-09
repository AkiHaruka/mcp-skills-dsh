/**
 * mcp-skills-dsh · MCP 运行时探测（host 半辅助模块，见 PLAN.md §1.4）
 *
 * 双层覆盖 + 零依赖兜底：
 *   Tier A  manager 条目 → ctx.get('mcpManager').list/probe/restart
 *   Tier B  直挂 client 条目 → ctx.registry 枚举 mcp-client fiber，
 *           可选动态 import dsh-mcp-client 拿 connectionStatusOf / probeServer，fiber.restart()
 *   兜底    ctx.tools.definitions() 数 mcp__<serverName>__ 前缀
 *
 * 纪律：装载期零 DSH 包依赖；动态 import 只在 action 执行期、try/catch、成功缓存。
 * 任何来源失败都静默降级，绝不向外抛。
 */

let clientMod = null
let clientModTried = false

/** 可选动态 import：只试一次，失败永久降级（同进程内解析不会变化）。 */
async function loadClientMod() {
  if (clientModTried) return clientMod
  clientModTried = true
  try { clientMod = await import('@deepseek-ai/dsh-mcp-client') } catch { clientMod = null }
  return clientMod
}

function safeGet(obj, key) { try { return obj?.[key] } catch { return undefined } }

/** 可选服务用 ctx.get（非 strict，缺省 undefined）；兜底 property 读。 */
function getManager(ctx) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get('mcpManager')
  } catch { /* fall through */ }
  return safeGet(ctx, 'mcpManager')
}

/** 枚举所有 mcp-client fiber（含 manager 挂载的实例），返回 {serverName, fiber}。 */
function clientFibers(ctx) {
  const out = []
  try {
    const registry = safeGet(ctx, 'registry')
    if (!registry || typeof registry.values !== 'function') return out
    for (const rt of registry.values()) {
      if (rt?.name !== 'mcp-client') continue
      const fibers = rt.fibers
      if (!fibers || typeof fibers[Symbol.iterator] !== 'function') continue
      for (const fiber of fibers) {
        const sn = safeGet(safeGet(fiber, 'config'), 'serverName')
        if (sn) out.push({ serverName: String(sn), fiber })
      }
    }
  } catch { /* 降级 */ }
  return out
}

/** 零依赖兜底：按已知 serverName 精确数 mcp__<serverName>__ 前缀工具。 */
function toolCounts(ctx, serverNames) {
  const counts = new Map()
  try {
    const tools = safeGet(ctx, 'tools')
    if (!tools || typeof tools.definitions !== 'function') return counts
    const defs = tools.definitions()
    const list = Array.isArray(defs) ? defs : Array.from(defs || [])
    for (const sn of serverNames) {
      const prefix = `mcp__${sn}__`
      let n = 0
      for (const d of list) if (typeof d?.name === 'string' && d.name.startsWith(prefix)) n++
      counts.set(sn, n)
    }
  } catch { /* 降级 */ }
  return counts
}

/** 把 manager/fiber 的 status 对象规整成统一行。 */
function rowFromStatus(serverName, status, source) {
  const row = { serverName, source, state: status?.state || 'unknown' }
  if (typeof status?.toolCount === 'number') row.toolCount = status.toolCount
  if (typeof status?.attempt === 'number') row.attempt = status.attempt
  if (status?.reason) row.reason = String(status.reason)
  const err = status?.lastError ?? status?.message
  if (err) row.lastError = String(err)
  return row
}

/** manager 是否认识某个 serverName（它只管自己的 servers + register）。 */
function managerHas(manager, serverName) {
  if (!manager || typeof manager.list !== 'function') return false
  try { return manager.list().some((v) => v?.name === serverName) } catch { return false }
}

/**
 * 运行时列表：合并 manager → fiber → tools 三路，按 serverName 去重（manager 优先）。
 * @returns {{runtime:'ok'|'unavailable', servers:Array}}
 */
export async function runtimeList(ctx, { serverNames = [] } = {}) {
  const rows = new Map()
  const known = new Set((serverNames || []).map(String))

  const manager = getManager(ctx)
  let managerOk = false
  if (manager && typeof manager.list === 'function') {
    try {
      for (const view of manager.list()) {
        if (!view?.name) continue
        known.add(String(view.name))
        rows.set(String(view.name), rowFromStatus(String(view.name), view.status, 'manager'))
        managerOk = true
      }
    } catch { /* manager 在但 list 抛错 → 降级 */ }
  }

  const mod = await loadClientMod()
  let fiberOk = false
  if (mod && typeof mod.connectionStatusOf === 'function') {
    for (const { serverName, fiber } of clientFibers(ctx)) {
      known.add(serverName)
      if (rows.has(serverName)) continue // manager 优先
      try {
        const handle = mod.connectionStatusOf(fiber)
        const status = handle && typeof handle.current === 'function' ? handle.current() : null
        if (status) { rows.set(serverName, rowFromStatus(serverName, status, 'fiber')); fiberOk = true }
      } catch { /* skip this fiber */ }
    }
  }

  let toolsOk = false
  const needFallback = [...known].filter((n) => !rows.has(n))
  if (needFallback.length) {
    const counts = toolCounts(ctx, needFallback)
    if (counts.size) {
      toolsOk = true
      for (const [sn, n] of counts) rows.set(sn, { serverName: sn, state: 'unknown', toolCount: n, source: 'tools' })
    }
  }

  if (!managerOk && !fiberOk && !toolsOk && rows.size === 0) return { runtime: 'unavailable', servers: [] }
  return { runtime: 'ok', servers: [...rows.values()] }
}

/**
 * 测试连接：manager 条目走 manager.probe；client 条目走 probeServer。
 * entryConfig 是 YAML 里的原始 config（client 条目需要，manager 条目内部自有）。
 * @returns {{ok:boolean, source?:string, result?:object, error?:string}} result.ok 才是「可达」。
 */
export async function runtimeProbe(ctx, serverName, entryConfig) {
  const manager = getManager(ctx)
  if (managerHas(manager, serverName) && typeof manager.probe === 'function') {
    try {
      const result = await manager.probe(serverName, { timeoutMs: 15000 })
      return { ok: true, source: 'manager', result }
    } catch (e) { return { ok: false, source: 'manager', error: String(e?.message || e) } }
  }
  const mod = await loadClientMod()
  if (mod && typeof mod.probeServer === 'function' && entryConfig) {
    try {
      const config = typeof mod.Config === 'function' ? mod.Config(entryConfig) : entryConfig
      const result = await mod.probeServer(ctx, config, { timeoutMs: 15000 })
      return { ok: true, source: 'fiber', result }
    } catch (e) { return { ok: false, source: 'fiber', error: String(e?.message || e) } }
  }
  return { ok: false, error: 'probe unavailable（无 mcpManager 且无法 import dsh-mcp-client）' }
}

/**
 * 重启实例（运行时写操作，confirm 门在 index.js）：manager.restart 或 fiber.restart。
 * 不修改配置文件。
 */
export async function runtimeRestart(ctx, serverName) {
  const manager = getManager(ctx)
  if (managerHas(manager, serverName) && typeof manager.restart === 'function') {
    try { await manager.restart(serverName); return { ok: true, source: 'manager' } }
    catch (e) { return { ok: false, source: 'manager', error: String(e?.message || e) } }
  }
  for (const { serverName: sn, fiber } of clientFibers(ctx)) {
    if (sn !== serverName) continue
    if (typeof fiber?.restart !== 'function') return { ok: false, error: 'fiber.restart 不可用' }
    try { await fiber.restart(); return { ok: true, source: 'fiber' } }
    catch (e) { return { ok: false, source: 'fiber', error: String(e?.message || e) } }
  }
  return { ok: false, error: `找不到运行时 server: ${serverName}` }
}