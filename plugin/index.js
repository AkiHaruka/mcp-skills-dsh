/**
 * mcp-skills-dsh · host 半
 *
 * 自包含 DSH bundle：只从包内 ./lib 加载纯函数，不引用仓库根、不 import 任何 DSH 内部包。
 *
 * 关于工具注册 API 的结论（依据 deepseek-harness 源码，见 README/汇报）：
 *  - 权威范式 packages/boot/plugin-manager/src/tools.ts:86 是
 *      ctx.tools.register(defineTool({ ... }))
 *  - 但 defineTool 并非「纯类型标记」：packages/core/tools/src/schema.ts:555-633 显示它会
 *      ① 把「作者 DSL」parameters 编译成原始 JSON Schema；② 校验 output.schema；
 *      ③ 包装 execute 做参数校验。它是编译器 + 包装器。
 *  - 而 ctx.tools.register()（packages/core/tools/src/index.ts:128-153）并不要求
 *      defineTool 的产物：它只校验 definition.output.render / output.schema / timeoutMs / name，
 *      随后把 definition 原样存入 registry。parameters 会被直接投影给模型。
 *  - 因此这里采用官方建议的「传普通对象」路径：直接给出一个已编译好、合法的
 *      ToolDefinition（parameters 为原始 JSON Schema，output.schema={type:'string'}），
 *      完全避免 import '@deepseek-ai/dsh-tools'，也就没有 peerDependencies / 解析风险。
 *
 * 约束：
 *  - 顶层 try/catch 隔离：任何异常只 ctx.logger?.warn，绝不抛给 DSH、不阻塞装载。
 *  - enabled:false 熔断：config.enabled === false 时不注册（patch 默认 enabled:true）。
 *  - 写操作默认 dry-run：confirm !== true 只回 diff、绝不落盘；confirm === true 才 apply:true。
 *    所有写入统一由 lib 内部的 commitFile 完成备份 / 原子写 / 回滚。
 */
import fs from 'node:fs'
import { mountHostApi } from './host-api.js'
import { runtimeList, runtimeProbe, runtimeRestart } from './runtime.js'

export const name = 'dsh-admin'
export const inject = ['tools']

export const PLUGIN_VERSION = '0.6.1'

// 只读 / 导出（不落盘）
const READ_ACTIONS = [
  'status', 'list_mcp', 'get_mcp', 'list_skills', 'get_skill', 'validate_mcp', 'export_skills',
  'runtime_list', 'runtime_probe'
]
// 写操作（默认 dry-run，confirm === true 才落盘）
const WRITE_ACTIONS = [
  'set_mcp_enabled', 'set_skill_enabled', 'add_mcp', 'update_mcp', 'remove_mcp',
  'create_skill', 'remove_skill', 'import_skills', 'runtime_restart'
]
const ALL_ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS]

let LIB = null
/** 只加载包内 ./lib（自包含形态），不回退到仓库根 ../lib。 */
async function loadLib() {
  if (LIB) return LIB
  LIB = await import('./lib/index.mjs')
  return LIB
}

/**
 * cordis Context 的属性是 accessor：未 inject 的服务直接读取会抛
 * `cannot get property "dshHome" without inject`。逐个安全读取。
 */
function safeGet(obj, key) {
  try { return obj?.[key] } catch { return undefined }
}
/**
 * 管理目标由启动参数 DSH_ADMIN_HOME / DSH_ADMIN_PROFILE 显式指定，
 * 避免把「运行插件的 profile」误当成「被管理的配置」。
 * 未指定时退回当前 DSH 实例自身的 home/profile。
 */
function resolveHome(ctx, lib, config) {
  return (
    process.env.DSH_ADMIN_HOME ||
    safeGet(config, 'dshHome') ||
    safeGet(ctx, 'dshHome') || safeGet(safeGet(ctx, 'config'), 'dshHome') ||
    safeGet(safeGet(ctx, 'profileContext'), 'home') ||
    process.env.DSH_HOME ||
    lib.getDshHome()
  )
}
/**
 * profile 解析优先级（2026-11-09 爹地实测反馈修复）：
 * 1. DSH_ADMIN_PROFILE env —— 显式管理目标
 * 2. apply(config).profile —— patch config 显式指定
 * 3. ctx.profileContext.name —— 运行时权威（web profile 会话 → 'web'）
 * 4. ctx.root 兜底（root.profileContext.name / root.profile）
 * 5. DSH_PROFILE env → 'desktop'
 */
function resolveProfile(ctx, config) {
  const pc = safeGet(ctx, 'profileContext')
  const rootPc = safeGet(safeGet(ctx, 'root'), 'profileContext')
  return (
    process.env.DSH_ADMIN_PROFILE ||
    safeGet(config, 'profile') ||
    safeGet(ctx, 'profile') || safeGet(safeGet(ctx, 'config'), 'profile') ||
    safeGet(pc, 'name') || safeGet(rootPc, 'name') ||
    safeGet(safeGet(ctx, 'root'), 'profile') ||
    process.env.DSH_PROFILE || 'desktop'
  )
}

/** 统一 id/名称取值：兼容 id / target / name 三种入参写法。 */
function pickId(a) {
  return String(a.id || a.target || a.name || '')
}

/**
 * 注册工具。优先 ctx.tools.register（权威 API，收普通对象）。
 * 附带少量等价入口做兼容兜底，任一失败都只 warn，不影响装载。
 */
function registerTool(ctx, tool) {
  // ctx.tools.register() 内部依赖 this.layers.effect(...)，必须以 tools 服务为
  // 接收者调用（见 packages/core/tools/src/index.ts:128）。用 ctx 当 this 会抛错。
  // 它返回的 disposer 要挂到 ctx.effect，HMR 卸载时才能注销工具。
  const tools = ctx?.tools
  if (tools && typeof tools.register === 'function') {
    const disposer = tools.register(tool)
    if (typeof disposer === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => disposer)
    }
    return true
  }
  // 兼容兜底：这些入口没有 this 依赖，直接调用即可。
  for (const fn of [ctx?.tool, ctx?.registerTool, ctx?.tools?.define]) {
    if (typeof fn === 'function') {
      try {
        fn.call(ctx, tool)
        return true
      } catch (e) {
        ctx?.logger?.warn?.('[dsh-admin] 注册入口调用失败：' + String(e?.message || e))
        return false
      }
    }
  }
  return false
}

export function apply(ctx, config = {}) {
  // —— 顶层隔离：整个装载过程不允许把异常抛给 DSH ——
  try {
    // enabled:false 熔断（patch 默认为 true，装了就能用）
    if (config && config.enabled === false) {
      ctx?.logger?.warn?.('[dsh-admin] config.enabled:false，已熔断，未注册工具')
      return
    }

    const warn = (msg) => {
      try { ctx?.logger?.warn?.('[dsh-admin] ' + msg) } catch { /* 彻底静默 */ }
    }

    /** dsh_admin.execute：所有 action 复用 lib 纯函数，返回 JSON 字符串。 */
    const execute = async (args) => {
      try {
        const a = (args && typeof args === 'object') ? args : {}
        const lib = await loadLib()
        const dshHome = resolveHome(ctx, lib, config)
        const profile = resolveProfile(ctx, config)
        const patchPath = lib.getPatchPath(dshHome, profile)
        // 确定性 skill roots：以 dshHome 为基准，避免 cwd / 系统 ~/.agents 干扰计数
        const skillOpts = { projectRoot: dshHome, agentsHome: dshHome }
        const action = String(a.action || 'status')
        const applyWrite = a.confirm === true
        const ident = pickId(a)
        const enabled = a.enabled === undefined ? true : Boolean(a.enabled)

        const envelope = (extra) => JSON.stringify({
          ok: true, action, applied: false, dryRun: false, dshHome, profile, ...extra
        }, null, 2)
        const writeResult = (res) => JSON.stringify({
          ok: !res.error,
          action,
          applied: !!res.applied,
          dryRun: !applyWrite,
          confirm: applyWrite,
          dshHome,
          profile,
          diff: res.diff,
          changed: res.changed,
          backupPath: res.backupPath ?? null,
          error: res.error ?? null,
          data: res
        }, null, 2)

        switch (action) {
          // ---------- 只读 ----------
          case 'status': {
            const mcpCount = lib.listMcp(patchPath).length
            const skillsCount = lib.listSkills(dshHome, skillOpts).length
            const data = {
              version: PLUGIN_VERSION,
              libVersion: lib.VERSION,
              dshHome,
              profile,
              patchPath,
              patchExists: fs.existsSync(patchPath),
              mcpCount,
              skillsCount
            }
            // 顶层也展开计数，便于调用方 / 测试直接读取
            return JSON.stringify({
              ok: true, action, applied: false, dryRun: false,
              ...data, data
            }, null, 2)
          }
          case 'list_mcp':
            return envelope({ data: lib.listMcp(patchPath) })
          case 'get_mcp':
            return envelope({ data: lib.getMcp(patchPath, ident) })
          case 'list_skills':
            return envelope({ data: lib.listSkills(dshHome, skillOpts) })
          case 'get_skill':
            return envelope({ data: lib.getSkill(dshHome, ident, skillOpts) })
          case 'validate_mcp':
            return envelope({ data: lib.validateAll(patchPath) })
          case 'export_skills':
            // 导出不写盘，直接返回可 JSON 序列化的数据（无需 confirm）
            return envelope({ data: lib.exportSkills(dshHome, skillOpts) })

          // ---------- 运行时（只读，不写配置） ----------
          case 'runtime_list': {
            const serverNames = lib.listMcp(patchPath).map((e) => e.serverName)
            return envelope({ data: await runtimeList(ctx, { serverNames }) })
          }
          case 'runtime_probe': {
            const entry = lib.listMcp(patchPath).find((e) => e.serverName === ident || e.id === ident)
            return envelope({ data: await runtimeProbe(ctx, ident, entry?.raw?.config) })
          }

          // ---------- 写（默认 dry-run） ----------
          case 'set_mcp_enabled':
            return writeResult(lib.setMcpEnabled(patchPath, ident, enabled, { apply: applyWrite }))
          case 'set_skill_enabled':
            return writeResult(lib.setSkillEnabled(dshHome, ident, enabled, { apply: applyWrite }))
          case 'add_mcp': {
            const src = (a.entry && typeof a.entry === 'object') ? a.entry : {}
            const entry = { ...src }
            if (!entry.id && ident) entry.id = ident
            if (!entry.serverName && a.name) entry.serverName = String(a.name)
            return writeResult(lib.addMcp(patchPath, entry, { apply: applyWrite }))
          }
          case 'update_mcp': {
            const patch = (a.entry && typeof a.entry === 'object') ? a.entry : {}
            return writeResult(lib.updateMcp(patchPath, ident, patch, { apply: applyWrite }))
          }
          case 'remove_mcp':
            return writeResult(lib.removeMcp(patchPath, ident, { apply: applyWrite }))
          case 'create_skill':
            return writeResult(lib.createSkill(dshHome, ident, {
              apply: applyWrite,
              description: a.description,
              whenToUse: a.whenToUse
            }))
          case 'remove_skill':
            return writeResult(lib.removeSkill(dshHome, ident, { apply: applyWrite }))
          case 'import_skills': {
            let input = a.entry
            if (!input || typeof input !== 'object') {
              const raw = String(a.target || a.description || '')
              try { input = JSON.parse(raw) } catch { input = raw }
            }
            return writeResult(lib.importSkills(dshHome, input, { apply: applyWrite }))
          }
          case 'runtime_restart': {
            // 运行时写操作：不写配置、无 diff/备份，独立信封；confirm 门与其他写操作一致
            if (!applyWrite) {
              return JSON.stringify({
                ok: true, action, applied: false, dryRun: true, confirm: false,
                dshHome, profile, serverName: ident,
                preview: `将重启运行时 server「${ident}」（不修改配置文件）`
              }, null, 2)
            }
            const res = await runtimeRestart(ctx, ident)
            return JSON.stringify({
              ok: !!res.ok, action, applied: true, dryRun: false, confirm: true,
              dshHome, profile, serverName: ident, source: res.source ?? null, error: res.error ?? null
            }, null, 2)
          }

          default:
            return JSON.stringify({
              ok: false, action, applied: false, dryRun: false,
              error: `未知 action: ${action}`,
              supported: ALL_ACTIONS,
              hint: '写操作需带 confirm:true 才会真正落盘，否则只返回 diff 预览'
            }, null, 2)
        }
      } catch (e) {
        warn('dsh_admin 执行失败：' + String(e?.message || e))
        return JSON.stringify({ ok: false, error: String(e?.message || e) })
      }
    }

    // 已编译好的「原始 JSON Schema」parameters —— 因为绕过 defineTool，需直接给编译产物。
    // 支持子集见 packages/core/tools/src/json-schema.ts:310-322（type/properties/required/enum/...）。
    const parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string', enum: ALL_ACTIONS,
          description: '操作名；只读/导出直接返回数据，写操作默认 dry-run'
        },
        target: { type: 'string', description: 'MCP id / skill 名 / import JSON 字符串（按 action 而定）' },
        id: { type: 'string', description: 'MCP 条目 id（get/add/update/remove_mcp、set_mcp_enabled 等）' },
        name: { type: 'string', description: 'serverName 或 skill 名（get/create/remove_skill、runtime_probe/runtime_restart 用 serverName）' },
        enabled: { type: 'boolean', description: '启停目标状态（set_*_enabled）' },
        confirm: { type: 'boolean', description: '写操作置 true 才真正落盘；缺省/false 仅返回 diff 预览' },
        entry: { type: 'object', additionalProperties: true, description: 'add_mcp 的条目对象 / update_mcp 的字段 patch（null 清字段）/ import_skills 的导出对象' },
        description: { type: 'string', description: 'create_skill 的 description' }
      },
      required: ['action'],
      additionalProperties: true
    }

    const tool = {
      name: 'dsh_admin',
      description:
        'DSH 配置与运行时管理：查询 MCP / skills / 状态，启停、新增、编辑（update_mcp）或删除条目，探测 MCP 运行时连接（runtime_list/probe/restart）。' +
        '配置写操作默认 dry-run（只回 diff 不落盘），必须显式 confirm:true 才会写入；' +
        '写入经备份 / 原子写 / 回滚。runtime_restart 同样需 confirm:true，但不改配置文件。action 取值见 parameters.action.enum。',
      parameters,
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: String(v) }]
      },
      execute
    }

    let toolRegistered = false
    if (!registerTool(ctx, tool)) {
      warn('当前 ctx 未提供可用的 tools.register 接口，未注册工具（不影响装载）')
    } else {
      toolRegistered = true
      ctx?.logger?.info?.('[dsh-admin] 已注册工具 dsh_admin（自包含，启动零网络）')
    }

    // 给左侧栏独立管理页提供同源 HTTP API（web/headless 均可用；无 webServer 时静默降级）
    mountHostApi(ctx, execute, warn)
    if (!toolRegistered) warn('工具未注册，但 HTTP API 仍尝试挂载')
  } catch (e) {
    try {
      ctx?.logger?.warn?.('[dsh-admin] apply 异常已隔离：' + String(e?.message || e))
    } catch { /* 彻底静默：绝不抛给 DSH、不阻塞装载 */ }
  }
}
