/**
 * mcp-skills-dsh · Host HTTP API
 *
 * 给 client 半的独立管理页提供同源数据通道。
 * 官方依据（deepseek-harness 0.2.2-rc.1）：
 *   - packages/host/webserver/src/index.ts:445  ctx.webServer.register({ kind, path, handler })
 *   - packages/client/connection/src/index.ts:145  ctx.connection.admit(req) 做同源/鉴权
 *   - packages/api/gateway/src/index.ts:255  ctx.inject(['connection','webServer'], cb) 等服务就绪
 *
 * 路由：GET/POST /dsh-admin/api  (exact)
 *   GET  ?action=<只读 action>&...     -> execute({...})
 *   POST body = { action, ... }        -> execute({...})
 * 所有写操作沿用 execute 的 confirm:true 门禁（默认 dry-run）。
 */
import fs from 'node:fs'

export const API_PATH = '/dsh-admin/api'
const MAX_BODY = 256 * 1024

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': type,
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(buf)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('请求体不是合法 JSON: ' + e.message)) }
    })
    req.on('error', reject)
  })
}

/**
 * @param {object} ctx        cordis Context（host 半 apply 的 ctx）
 * @param {(args:object)=>Promise<string>} execute  dsh_admin 的执行函数，返回 JSON 字符串
 * @param {(msg:string)=>void} warn
 */
export function mountHostApi(ctx, execute, warn) {
  try {
    ctx.inject(['webServer', 'connection'], (scope) => {
      try {
        const route = {
          kind: 'exact',
          path: API_PATH,
          handler: async (req, res) => {
            try {
              // 与官方 /api 路由一致的准入检查（Host/Origin fence + 已认证 Peer）
              const admission = scope.connection.admit(req)
              if ('rejection' in admission) {
                send(res, admission.rejection, { ok: false, error: 'unauthorized' })
                return
              }
              let args
              if (req.method === 'POST' || req.method === 'PUT') {
                args = await readBody(req)
              } else if (req.method === 'GET' || req.method === 'HEAD') {
                const u = new URL(req.url || '/', 'http://localhost')
                args = Object.fromEntries(u.searchParams.entries())
                // 'true'/'false' 还原成布尔
                for (const k of ['confirm', 'enabled']) {
                  if (args[k] === 'true') args[k] = true
                  else if (args[k] === 'false') args[k] = false
                }
              } else {
                send(res, 405, { ok: false, error: 'method not allowed' })
                return
              }
              const text = await execute(args || {})
              send(res, 200, text, 'application/json; charset=utf-8')
            } catch (e) {
              warn('API 处理失败：' + String(e?.message || e))
              send(res, 400, { ok: false, error: String(e?.message || e) })
            }
          }
        }
        const dispose = scope.webServer.register(route)
        scope.effect(() => dispose, 'dsh-admin: host api route')
        ctx?.logger?.info?.('[dsh-admin] 已挂载 HTTP API ' + API_PATH)
      } catch (e) {
        warn('webServer 路由注册失败：' + String(e?.message || e))
      }
    })
  } catch (e) {
    warn('ctx.inject 失败：' + String(e?.message || e))
  }
}

export { fs }
