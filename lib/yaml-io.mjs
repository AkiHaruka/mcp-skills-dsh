/**
 * YAML 读写基础设施。
 *
 * 核心技术选择（round-trip 保真）：
 *  - 用 eemeli/yaml 的 parseDocument() 得到 AST（Document），而不是 parse() 得到纯 JS 对象。
 *    AST 会保留：注释(commentBefore/comment)、键顺序、标量引号风格、块标量(| / >)、
 *    以及未知 tag（如 DSH 的 !!js 惰性表达式）——!!js 节点会被当作带 tag 的 Scalar 保留，
 *    toString() 时原样输出，toJS() 时退化成字符串，不会求值、不会抛错。
 *  - 所有修改都在 AST 上做（set / delete / items.splice / createNode），
 *    再用 doc.toString({lineWidth:0}) 输出；lineWidth:0 防止长 URL(Exa) 被折行破坏。
 *  - 写前校验「解析 → toString → 再解析 → toString」幂等且等于待写内容，
 *    保证写入的永远是合法且稳定的 YAML。
 *  - 原子写：先写 .tmp 再 rename；写前自动 .bak-YYYYMMDD-HHmmss 备份；失败从备份回滚。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

const { parseDocument, isMap, isSeq, parse } = YAML

export { isMap, isSeq }

export function parseDoc(content) {
  return parseDocument(String(content ?? ''), { keepSourceTokens: true })
}

/** 纯 JS 解析（用于 frontmatter / 导入文件） */
export function parseYaml(text) {
  return parse(String(text ?? ''))
}

export function docToJS(doc) {
  return doc.toJS({ maxAliasCount: 10000 })
}

export function docToString(doc) {
  // lineWidth: 0 关闭自动折行，避免长 URL 被切断
  return doc.toString({ lineWidth: 0 })
}

/**
 * 按路径定位 AST 节点。loc 元素：字符串=Map key，数字=Seq 下标。
 * 任一环不存在返回 undefined。
 */
export function getNodeAt(doc, loc) {
  let node = doc.contents
  for (const seg of loc) {
    if (node == null) return undefined
    if (isMap(node)) node = node.get(seg, true)
    else if (isSeq(node)) node = node.get(seg, true)
    else return undefined
  }
  return node
}

/**
 * 在 YAMLMap 节点上设置键值。对象/数组先用 doc.createNode 转成节点，
 * scalar 直接传值——两种都经 probe 验证可保留其余节点(含 !!js)不变。
 */
export function setMapValue(doc, mapNode, key, value) {
  const isObj = value !== null && typeof value === 'object'
  mapNode.set(key, isObj ? doc.createNode(value) : value)
}

export function createNode(doc, value) {
  return doc.createNode(value)
}

/** 备份文件名时间戳：YYYYMMDD-HHmmss */
export function backupStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 生成带上下文的 unified 风格 diff（纯文本，行级 LCS）。
 * 未变更的区域用 `  ...` 折叠。
 */
export function diffText(oldText, newText, context = 3) {
  const a = String(oldText ?? '').split('\n')
  const b = String(newText ?? '').split('\n')
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ t: ' ', s: a[i++] , j: j++ })
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', s: a[i++] })
    else ops.push({ t: '+', s: b[j++] })
  }
  while (i < n) ops.push({ t: '-', s: a[i++] })
  while (j < m) ops.push({ t: '+', s: b[j++] })

  if (!ops.some((o) => o.t !== ' ')) return '（无变化）'

  const keep = new Set()
  ops.forEach((o, idx) => {
    if (o.t !== ' ') {
      for (let k = idx - context; k <= idx + context; k++) if (k >= 0 && k < ops.length) keep.add(k)
    }
  })
  const out = ['--- 当前文件', '+++ 将要写入']
  let last = -1
  for (let k = 0; k < ops.length; k++) {
    if (!keep.has(k)) continue
    if (last >= 0 && k - last > 1) out.push('  ...')
    out.push(ops[k].t + ' ' + ops[k].s)
    last = k
  }
  return out.join('\n')
}

/**
 * 提交一次写入（唯一的落盘入口）。
 *
 * @param {string} filePath 绝对路径
 * @param {string} newContent 待写入的完整内容（应为 docToString 的输出）
 * @param {object} opts
 * @param {boolean} [opts.apply=false] 为 false 时只返回 diff，绝不落盘
 * @param {boolean} [opts.backup=true] 是否自动备份
 * @param {boolean} [opts.validateYaml=true] 是否按纯 YAML 做解析回读校验；
 *        SKILL.md 是 YAML frontmatter + Markdown 混合，需传 false 并用 verify 自检
 * @param {(text:string)=>void} [opts.verify] 业务层额外校验（可抛错）
 * @returns {{applied:boolean, diff:string, changed:boolean, backupPath:string|null, error?:string}}
 */
export function commitFile(filePath, newContent, opts = {}) {
  const { apply = false, backup = true, verify, validateYaml = true } = opts
  const abs = path.resolve(String(filePath))
  const oldText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''
  const diff = diffText(oldText, newContent)
  const base = { diff, changed: oldText !== newContent }

  // dry-run：只返回 diff，绝不落盘
  if (!apply) return { ...base, applied: false, backupPath: null }

  // 写前校验：解析回读幂等 + 内容稳定（纯 YAML 时）；再跑业务层校验
  try {
    if (validateYaml) {
      const d1 = parseDoc(newContent)
      const s1 = docToString(d1)
      const d2 = parseDoc(s1)
      const s2 = docToString(d2)
      if (d1.errors.length || d2.errors.length || s1 !== s2 || s1 !== newContent) {
        throw new Error('YAML 解析回读不一致')
      }
    }
    if (typeof verify === 'function') verify(newContent)
  } catch (e) {
    return { ...base, applied: false, backupPath: null, error: '写前校验失败：' + (e?.message || String(e)) }
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true })
  let backupPath = null
  if (backup && fs.existsSync(abs)) {
    backupPath = abs + '.bak-' + backupStamp()
    fs.copyFileSync(abs, backupPath)
  }

  const tmp = abs + '.tmp-' + process.pid
  try {
    fs.writeFileSync(tmp, newContent, 'utf8')
    fs.renameSync(tmp, abs)
    if (fs.readFileSync(abs, 'utf8') !== newContent) throw new Error('写后回读内容不一致')
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* ignore */ }
    if (backupPath && fs.existsSync(backupPath)) fs.copyFileSync(backupPath, abs)
    return { ...base, applied: false, backupPath, error: '写入失败已回滚：' + (e?.message || String(e)) }
  }
  return { ...base, applied: true, backupPath }
}
