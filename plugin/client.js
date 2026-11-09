/**
 * mcp-skills-dsh · Client 半：左侧栏入口 + 独立管理页
 *
 * 官方依据（deepseek-harness 0.2.2-rc.1）：
 *  - `sidebar.panellist` (list, root)：左侧栏全局面板入口，id 必须与 main 面板 key 一致
 *      packages/client/ui-plugin-manager/src/client/index.ts:168
 *      packages/client/ui-sidebar/src/client/contract/slots.ts:47,92
 *  - `main` (keyed, root)：主区域面板，`renderSlot('main', {}, { entryKey: panelId })`
 *      packages/client/ui-layout/src/client/index.ts:75 / AppFrame.tsx:49
 *  - `ctx.slots.inject` + `ctx.slots.register` + `ctx.locale.register` 范式
 *      apps/web/tests/fixtures/plugins/fixture-live-client/client.js
 *  - 数据通道：host-api.js 挂载的同源 `/dsh-admin/api`
 *
 * 全程 try/catch，任何 API 形态不匹配都降级，绝不白屏、绝不抛给 DSH。
 */
;(function () {
  var PKG = 'mcp-skills-dsh'
  var PANEL_ID = 'dsh-admin'
  var NS = 'dshAdmin'
  var API = '/dsh-admin/api'

  var ZH = {
    panel: 'MCP-Skills-DSH',
    title: 'MCP-Skills-DSH',
    subtitle: 'MCP 服务与 Skills 的直接管理',
    mcp: 'MCP 服务',
    skills: 'Skills',
    refresh: '刷新',
    loading: '加载中…',
    enabled: '启用',
    disabled: '停用',
    enable: '启用',
    disable: '停用',
    add: '新增 MCP',
    create: '新建 Skill',
    remove: '删除',
    confirm: '确认应用',
    cancel: '取消',
    dryRun: '预览（不落盘）',
    applied: '已应用',
    diff: '变更预览',
    result: '执行结果',
    empty: '暂无条目',
    id: 'ID',
    name: '名称',
    transport: '传输',
    source: '来源',
    state: '状态',
    action: '操作',
    dshHome: 'DSH_HOME',
    profile: 'Profile',
    writeGuard: '写操作默认仅预览，点「确认应用」才会写入（自动备份）',
    error: '加载失败',
    desc: '描述',
    cmd: '命令',
    submit: '提交',
    close: '关闭',
    confirmTitle: '确认写入配置？',
    confirmBody: '此操作会修改 DSH 配置文件，写入前会自动备份。',
    ok: '成功',
    fail: '失败',
    runtime: '运行时',
    test: '测试',
    restart: '重启',
    rtUnavailable: '运行时不可用（非 Harness 环境，仅显示静态配置）',
    probeOk: '连接成功',
    probeFail: '连接失败',
    latency: '延迟',
    tools: '工具',
    stConnected: '运行中',
    stConnecting: '连接中',
    stReconnecting: '重连中',
    stFailed: '失败',
    stClosed: '已关闭',
    stWaitingCred: '等待凭证',
    stDisabled: '已停用',
    stUnknown: '未知',
    stNone: '无实例',
    edit: '编辑',
    editMcp: '编辑 MCP',
    url: 'URL',
    headers: '请求头（K=V）',
    env: '环境变量（K=V）',
    args: '参数（每行一个，不按空格拆分）',
    cwd: '工作目录（可选）',
    timeout: '调用超时 ms（可选）',
    addRow: '＋ 添加一行',
    needId: '请填写 ID',
    needCmd: 'stdio 必须填写命令',
    needUrl: 'streamable-http 必须填写 URL',
    badTimeout: '超时必须为正数',
    noChange: '没有变更',
    notFound: '条目不存在或已删除',
    searchPh: '搜索名称 / 描述 / 来源…',
    noMatch: '无匹配条目',
    detail: '详情',
    body: '正文',
    modelInvocable: '模型可调用',
    userInvocable: '用户可调用',
    whenToUse: '何时使用',
    shadowed: '同名被遮蔽'
  }
  var EN = {
    panel: 'MCP-Skills-DSH', title: 'MCP-Skills-DSH', subtitle: 'Manage MCP servers and Skills',
    mcp: 'MCP Servers', skills: 'Skills', refresh: 'Refresh', loading: 'Loading…',
    enabled: 'Enabled', disabled: 'Disabled', enable: 'Enable', disable: 'Disable',
    add: 'Add MCP', create: 'New Skill', remove: 'Remove', confirm: 'Apply', cancel: 'Cancel',
    dryRun: 'Preview only', applied: 'Applied', diff: 'Diff preview', result: 'Result',
    empty: 'No entries', id: 'ID', name: 'Name', transport: 'Transport', source: 'Source',
    state: 'State', action: 'Actions', dshHome: 'DSH_HOME', profile: 'Profile',
    writeGuard: 'Writes are preview-only until you press Apply (auto backup).',
    error: 'Load failed', desc: 'Description', cmd: 'Command', submit: 'Submit',
    close: 'Close', confirmTitle: 'Apply changes?', confirmBody: 'This modifies DSH config. A backup is created first.',
    ok: 'OK', fail: 'Failed',
    runtime: 'Runtime', test: 'Test', restart: 'Restart',
    rtUnavailable: 'Runtime unavailable (not a Harness host; showing static config only)',
    probeOk: 'Connected', probeFail: 'Connection failed', latency: 'Latency', tools: 'tools',
    stConnected: 'Connected', stConnecting: 'Connecting', stReconnecting: 'Reconnecting',
    stFailed: 'Failed', stClosed: 'Closed', stWaitingCred: 'Waiting credentials',
    stDisabled: 'Disabled', stUnknown: 'Unknown', stNone: 'No instance',
    edit: 'Edit', editMcp: 'Edit MCP', url: 'URL',
    headers: 'Headers (K=V)', env: 'Env (K=V)', args: 'Args (one per row, no space-splitting)',
    cwd: 'Working dir (optional)', timeout: 'Call timeout ms (optional)', addRow: '+ Add row',
    needId: 'ID is required', needCmd: 'Command is required for stdio',
    needUrl: 'URL is required for streamable-http', badTimeout: 'Timeout must be a positive number',
    noChange: 'No changes', notFound: 'Entry not found',
    searchPh: 'Search name / description / source…', noMatch: 'No matches',
    detail: 'Detail', body: 'Body', modelInvocable: 'Model invocable', userInvocable: 'User invocable',
    whenToUse: 'When to use', shadowed: 'Shadowed by'
  }

  function boot() {
    var loader = window.__ModuleLoader__
    if (!loader || typeof loader.load !== 'function') return
    loader.load({
      id: PKG,
      factory: function (require) {
        var React
        try { React = require('react') } catch (e) { return { apply: function () {} } }
        var h = React.createElement
        var useState = React.useState, useEffect = React.useEffect, useCallback = React.useCallback

        // ---------- 数据请求 ----------
        function api(args, method) {
          var opts = { credentials: 'same-origin', headers: { 'content-type': 'application/json' } }
          if (method === 'POST') { opts.method = 'POST'; opts.body = JSON.stringify(args || {}) }
          else {
            var qs = new URLSearchParams()
            Object.keys(args || {}).forEach(function (k) {
              if (args[k] !== undefined && args[k] !== null) qs.set(k, String(args[k]))
            })
            opts.method = 'GET'
            return fetch(API + '?' + qs.toString(), opts).then(function (r) { return r.json() })
          }
          return fetch(API, opts).then(function (r) { return r.json() })
        }

        // ---------- 样式 ----------
        function useStyles() {
          useEffect(function () {
            if (document.querySelector('style[data-dsh-admin]')) return
            var s = document.createElement('style')
            s.setAttribute('data-dsh-admin', '1')
            s.textContent = [
              '.da-page{height:100%;flex:1 1 auto;min-height:0;overflow-y:auto;box-sizing:border-box}',
              '.da-wrap{padding:28px 32px;max-width:1180px;margin:0 auto;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.6}',
              '.da-h1{font-size:22px;font-weight:650;margin:0 0 4px}',
              '.da-sub{color:var(--dsw-alias-label-secondary,#a0a0a0);margin:0 0 18px}',
              '.da-meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:12px;margin-bottom:16px}',
              '.da-tabs{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22))}',
              '.da-tab{padding:8px 16px;cursor:pointer;border:none;background:none;color:var(--dsw-alias-label-secondary,#a0a0a0);border-bottom:2px solid transparent;font-size:13px}',
              '.da-tab.on{border-bottom-color:var(--dsw-alias-brand-primary,#5b9dff);color:var(--dsw-alias-brand-primary,#5b9dff);font-weight:600}',
              '.da-bar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}',
              '.da-btn{padding:5px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.32));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));color:inherit;cursor:pointer;font-size:12px}',
              '.da-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}',
              '.da-btn.pri{background:var(--dsw-alias-brand-primary,#2f6fd0);border-color:var(--dsw-alias-brand-primary,#2f6fd0);color:var(--dsw-alias-label-primary-inverted,#fff)}',
              '.da-btn.warn{border-color:var(--dsw-alias-state-error-primary,#c9564e);color:var(--dsw-alias-state-error-primary,#e88)}',
              '.da-note{padding:8px 12px;border-radius:7px;background:var(--dsw-alias-bg-layer-1,rgba(90,157,255,.09));border:1px solid var(--dsw-alias-border-l2,rgba(90,157,255,.28));font-size:12px;margin-bottom:12px}',
              '.da-table{width:100%;border-collapse:collapse;font-size:12px}',
              '.da-table th{text-align:left;padding:9px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));color:var(--dsw-alias-label-secondary,#a0a0a0);font-weight:500}',
              '.da-table td{padding:9px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));vertical-align:top}',
              '.da-table tr:hover td{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.05))}',
              '.da-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all}',
              '.da-pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35))}',
              '.da-pill.on{color:var(--dsw-alias-state-success-primary,#6cc08a);border-color:var(--dsw-alias-state-success-primary,#6cc08a)}',
              '.da-pill.off{opacity:.55}',
              '.da-pill.run{color:var(--dsw-alias-state-success-primary,#6cc08a);border-color:var(--dsw-alias-state-success-primary,#6cc08a)}',
              '.da-pill.wait{color:#d8a657;border-color:#d8a657}',
              '.da-pill.err{color:var(--dsw-alias-state-error-primary,#e88);border-color:var(--dsw-alias-state-error-primary,#e88)}',
              '.da-pill.cred{color:#b58cdb;border-color:#b58cdb}',
              '.da-pill.unk{opacity:.5}',
              '.da-card{padding:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));border-radius:9px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04))}',
              '.da-in{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.15));color:inherit;font-size:12px;margin:3px 0 8px}',
              '.da-pre{white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;padding:10px;border-radius:7px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.22));font-family:ui-monospace,Consolas,monospace;font-size:11px}',
              '.da-err{color:var(--dsw-alias-state-error-primary,#e88);font-size:12px}',
              '.da-row{display:flex;gap:6px;align-items:center;margin:0 0 4px}',
              '.da-row .da-in{margin:0;flex:1 1 auto}',
              '.da-row .da-in.da-k{flex:0 0 32%}',
              '.da-radio{display:flex;gap:16px;margin:3px 0 10px;font-size:12px}',
              '.da-radio label{display:flex;align-items:center;gap:5px;cursor:pointer}',
              '.da-form-title{font-weight:600;margin-bottom:10px}',
              '.da-empty{opacity:.5;padding:24px;text-align:center}'
            ].join('\n')
            document.head.appendChild(s)
          }, [])
        }

        // ---------- 主页面 ----------
        function AdminPage(props) {
          useStyles()
          var t = (props && props.t) || function (k) { return (ZH[k] !== undefined ? ZH[k] : k) }
          var tabState = useState('mcp')
          var tab = tabState[0], setTab = tabState[1]
          var dataState = useState(null)
          var data = dataState[0], setData = dataState[1]
          var errState = useState('')
          var err = errState[0], setErr = errState[1]
          var busyState = useState(false)
          var busy = busyState[0], setBusy = busyState[1]
          var pendingState = useState(null)
          var pending = pendingState[0], setPending = pendingState[1]
          var formState = useState(false)
          var showForm = formState[0], setShowForm = formState[1]
          var editState = useState(null)
          var editEntry = editState[0], setEditEntry = editState[1]
          var queryState = useState('')
          var query = queryState[0], setQuery = queryState[1]
          var detailState = useState(null)
          var detail = detailState[0], setDetail = detailState[1]
          var rtState = useState({})
          var rt = rtState[0], setRt = rtState[1]
          var rtOffState = useState(false)
          var rtOff = rtOffState[0], setRtOff = rtOffState[1]

          var load = useCallback(function () {
            setBusy(true); setErr('')
            Promise.all([
              api({ action: 'status' }),
              api({ action: 'list_mcp' }),
              api({ action: 'list_skills' })
            ]).then(function (r) {
              setData({ status: r[0], mcp: (r[1] && r[1].data) || [], skills: (r[2] && r[2].data) || [] })
            }).catch(function (e) { setErr(String(e && e.message || e)) })
              .finally(function () { setBusy(false) })
          }, [])
          useEffect(function () { load() }, [load])

          // 运行时状态：独立轮询 5s，页面隐藏时暂停；失败/不可用静默降级
          var loadRuntime = useCallback(function () {
            return api({ action: 'runtime_list' }).then(function (r) {
              var d = (r && r.data) || {}
              if (d.runtime === 'unavailable') { setRtOff(true); setRt({}); return }
              setRtOff(false)
              var map = {}
              ;(d.servers || []).forEach(function (s) { if (s && s.serverName) map[s.serverName] = s })
              setRt(map)
            }).catch(function () { /* 轮询失败不打断页面 */ })
          }, [])
          useEffect(function () {
            loadRuntime()
            var timer = setInterval(function () {
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
              loadRuntime()
            }, 5000)
            return function () { clearInterval(timer) }
          }, [loadRuntime])

          // 先 dry-run 预览，再确认写入
          function run(args, label) {
            setBusy(true); setErr('')
            return api(Object.assign({}, args, { confirm: false }), 'POST')
              .then(function (r) {
                setPending({ args: args, preview: r, label: label || args.action })
                setBusy(false)
              })
              .catch(function (e) { setErr(String(e && e.message || e)); setBusy(false) })
          }
          function commit() {
            if (!pending) return
            setBusy(true)
            return api(Object.assign({}, pending.args, { confirm: true }), 'POST')
              .then(function (r) {
                setPending({ args: null, preview: r, label: pending.label, done: true })
                setBusy(false); load(); loadRuntime()
              })
              .catch(function (e) { setErr(String(e && e.message || e)); setBusy(false) })
          }

          // 测试连接（只读，直接展示结果，无需 confirm）
          function probe(sn) {
            setBusy(true); setErr('')
            return api({ action: 'runtime_probe', name: sn }, 'POST')
              .then(function (r) {
                setPending({ preview: r, label: 'probe ' + sn, done: true })
                setBusy(false); loadRuntime()
              })
              .catch(function (e) { setErr(String(e && e.message || e)); setBusy(false) })
          }

          // 编辑：按 id 拉最新条目（get_mcp），预填表单；失败友好提示
          function editMcp(r) {
            var id = r.id || r.serverName
            setBusy(true); setErr('')
            api({ action: 'get_mcp', id: id }).then(function (res) {
              setBusy(false)
              if (!res || res.ok === false || !res.data) { setErr(t('notFound') + ': ' + id); return }
              setPending(null); setEditEntry(res.data); setShowForm(true)
            }).catch(function (e) { setErr(String(e && e.message || e)); setBusy(false) })
          }

          // Skills 详情：复用 get_skill（含 content/body/parts），null 友好提示
          function openSkill(r) {
            var name = r.name || r.dirName
            setDetail({ loading: true, name: name })
            api({ action: 'get_skill', name: name }).then(function (res) {
              if (!res || res.ok === false || !res.data) setDetail({ name: name, missing: true })
              else setDetail(res.data)
            }).catch(function (e) { setDetail({ name: name, error: String(e && e.message || e) }) })
          }

          // 运行时徽标：config 停用优先，其次运行时状态
          var RT_CLASS = { connected: 'run', connecting: 'wait', reconnecting: 'wait', failed: 'err', closed: 'err', 'waiting-credentials': 'cred', disabled: 'off', unknown: 'unk', none: 'unk' }
          var RT_KEY = { connected: 'stConnected', connecting: 'stConnecting', reconnecting: 'stReconnecting', failed: 'stFailed', closed: 'stClosed', 'waiting-credentials': 'stWaitingCred', disabled: 'stDisabled', unknown: 'stUnknown', none: 'stNone' }
          function rtPill(r) {
            var sn = r.serverName || r.id
            var info = rt[sn]
            var state = (r.enabled === false) ? 'disabled' : (info ? info.state : 'none')
            var cls = RT_CLASS[state] || 'unk'
            var label = t(RT_KEY[state] || 'stUnknown')
            var suffix = (info && typeof info.toolCount === 'number') ? (' · ' + info.toolCount + ' ' + t('tools')) : ''
            var title = (info && (info.lastError || info.reason)) || ''
            return h('span', { className: 'da-pill ' + cls, title: title }, label + suffix)
          }

          var st = (data && data.status) || {}
          var allRows = tab === 'mcp' ? ((data && data.mcp) || []) : ((data && data.skills) || [])
          var q = query.trim().toLowerCase()
          var rows = (tab === 'skills' && q)
            ? allRows.filter(function (s) {
                return ((s.name || '') + ' ' + (s.description || '') + ' ' + (s.source || '')).toLowerCase().indexOf(q) !== -1
              })
            : allRows

          return h('div', { className: 'da-page' },
          h('div', { className: 'da-wrap', 'data-dsh-admin-page': '1' },
            h('h1', { className: 'da-h1' }, t('title')),
            h('p', { className: 'da-sub' }, t('subtitle')),
            h('div', { className: 'da-meta' },
              h('span', null, t('dshHome'), ': ', h('span', { className: 'da-mono' }, String(st.dshHome || '—'))),
              h('span', null, t('profile'), ': ', String(st.profile || '—')),
              h('span', null, t('mcp'), ': ', String(st.mcpCount !== undefined ? st.mcpCount : '—')),
              h('span', null, t('skills'), ': ', String(st.skillsCount !== undefined ? st.skillsCount : '—'))),
            h('div', { className: 'da-tabs' },
              ['mcp', 'skills'].map(function (k) {
                return h('button', {
                  key: k, className: 'da-tab' + (tab === k ? ' on' : ''),
                  onClick: function () { setTab(k); setPending(null); setShowForm(false); setEditEntry(null); setDetail(null) }
                }, t(k === 'mcp' ? 'mcp' : 'skills'))
              })),
            h('div', { className: 'da-bar' },
              h('button', { className: 'da-btn', onClick: load, disabled: busy }, busy ? t('loading') : t('refresh')),
              h('button', { className: 'da-btn', onClick: function () { setEditEntry(null); setShowForm(!showForm) } },
                tab === 'mcp' ? t('add') : t('create')),
              h('span', { style: { opacity: .55, fontSize: 11 } }, t('writeGuard'))),
            err ? h('div', { className: 'da-err' }, t('error'), ': ', err) : null,
            (tab === 'mcp' && rtOff) ? h('div', { className: 'da-note' }, t('rtUnavailable')) : null,
            tab === 'skills' ? h('div', { className: 'da-bar' },
              h('input', {
                className: 'da-in', style: { maxWidth: '360px', margin: 0 }, value: query,
                placeholder: t('searchPh'), onChange: function (e) { setQuery(e.target.value) }
              }),
              q ? h('span', { style: { opacity: .6, fontSize: 12 } }, rows.length + ' / ' + allRows.length) : null) : null,
            detail ? h(SkillDetail, { detail: detail, t: t, onClose: function () { setDetail(null) } }) : null,
            showForm ? h(EntryForm, {
              key: editEntry ? 'edit-' + editEntry.id : 'add',
              tab: tab, t: t, entry: tab === 'mcp' ? editEntry : null,
              onSubmit: function (a, l) { run(a, l); setShowForm(false); setEditEntry(null) },
              onCancel: function () { setShowForm(false); setEditEntry(null) }
            }) : null,
            pending ? h(PendingCard, { pending: pending, t: t, busy: busy, onConfirm: commit, onClose: function () { setPending(null) } }) : null,
            h('table', { className: 'da-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('id')), h('th', null, t('name')),
                h('th', null, tab === 'mcp' ? t('transport') : t('source')),
                h('th', null, t('state')),
                tab === 'mcp' ? h('th', null, t('runtime')) : null,
                h('th', null, t('action')))),
              h('tbody', null, rows.length === 0
                ? h('tr', null, h('td', { colSpan: tab === 'mcp' ? 6 : 5, className: 'da-empty' },
                    (tab === 'skills' && q && allRows.length > 0) ? t('noMatch') : t('empty')))
                : rows.map(function (r, i) {
                  var id = tab === 'mcp' ? (r.id || r.serverName) : (r.name || r.dirName)
                  var on = tab === 'mcp' ? (r.enabled !== false) : (r.modelInvocable !== false && r.userInvocable !== false)
                  var action = tab === 'mcp' ? 'set_mcp_enabled' : 'set_skill_enabled'
                  var arg = tab === 'mcp' ? { id: id } : { name: id }
                  return h('tr', {
                    key: String(id) + i,
                    style: tab === 'skills' ? { cursor: 'pointer' } : undefined,
                    onClick: tab === 'skills' ? function (e) {
                      if (e.target && e.target.closest && e.target.closest('button')) return
                      openSkill(r)
                    } : undefined
                  },
                    h('td', null, h('span', { className: 'da-mono' }, String(id))),
                    h('td', null, String(tab === 'mcp' ? (r.serverName || '—') : (r.name || '—'))),
                    h('td', null, h('span', { className: 'da-mono' }, String(tab === 'mcp' ? (r.transport || '—') : (r.source || '—')))),
                    h('td', null, h('span', { className: 'da-pill ' + (on ? 'on' : 'off') }, t(on ? 'enabled' : 'disabled'))),
                    tab === 'mcp' ? h('td', null, rtPill(r)) : null,
                    h('td', null,
                      tab === 'mcp' ? h('button', { className: 'da-btn', disabled: busy, onClick: function () { probe(r.serverName || id) } }, t('test')) : null,
                      tab === 'mcp' ? h('button', { className: 'da-btn', disabled: busy, style: { marginLeft: 4 }, onClick: function () { run({ action: 'runtime_restart', name: r.serverName || id }, 'restart ' + (r.serverName || id)) } }, t('restart')) : null,
                      tab === 'mcp' ? h('button', { className: 'da-btn', disabled: busy, style: { marginLeft: 4 }, onClick: function () { editMcp(r) } }, t('edit')) : null,
                      h('button', { className: 'da-btn', disabled: busy, style: { marginLeft: tab === 'mcp' ? 4 : 0 }, onClick: function () {
                        run(Object.assign({ action: action, enabled: !on }, arg), action + ' ' + id)
                      } }, t(on ? 'disable' : 'enable')),
                      h('button', { className: 'da-btn warn', disabled: busy, style: { marginLeft: 4 }, onClick: function () {
                        run(Object.assign({ action: tab === 'mcp' ? 'remove_mcp' : 'remove_skill' }, arg), 'remove ' + id)
                      } }, t('remove'))))
                })))
          ))
        }

        // 字符串动态行（args）：每行一个值，不做空格拆分
        function ArgRows(props) {
          var rows = props.rows, onChange = props.onChange, t = props.t
          return h('div', null,
            rows.map(function (v, i) {
              return h('div', { className: 'da-row', key: i },
                h('input', { className: 'da-in', value: v, placeholder: props.placeholder || '', onChange: function (e) {
                  var next = rows.slice(); next[i] = e.target.value; onChange(next)
                } }),
                h('button', { className: 'da-btn', type: 'button', onClick: function () {
                  var next = rows.slice(); next.splice(i, 1); onChange(next)
                } }, '✕'))
            }),
            h('button', { className: 'da-btn', type: 'button', onClick: function () { onChange(rows.concat([''])) } }, t('addRow')))
        }

        // K=V 动态行（env / headers）
        function KvRows(props) {
          var rows = props.rows, onChange = props.onChange, t = props.t
          return h('div', null,
            rows.map(function (row, i) {
              return h('div', { className: 'da-row', key: i },
                h('input', { className: 'da-in da-k', value: row.k, placeholder: 'Key', onChange: function (e) {
                  var next = rows.slice(); next[i] = { k: e.target.value, v: row.v }; onChange(next)
                } }),
                h('input', { className: 'da-in', value: row.v, placeholder: 'Value', onChange: function (e) {
                  var next = rows.slice(); next[i] = { k: row.k, v: e.target.value }; onChange(next)
                } }),
                h('button', { className: 'da-btn', type: 'button', onClick: function () {
                  var next = rows.slice(); next.splice(i, 1); onChange(next)
                } }, '✕'))
            }),
            h('button', { className: 'da-btn', type: 'button', onClick: function () { onChange(rows.concat([{ k: '', v: '' }])) } }, t('addRow')))
        }

        function kvInit(obj) {
          var keys = Object.keys(obj || {})
          if (!keys.length) return [{ k: '', v: '' }]
          return keys.map(function (k) { return { k: k, v: String(obj[k]) } })
        }
        function kvObj(rows) {
          var o = {}
          rows.forEach(function (r) { if (r.k.trim()) o[r.k.trim()] = r.v })
          return o
        }

        // 新增 / 编辑共用表单：entry 为 null 走 add_mcp，否则预填走 update_mcp
        function EntryForm(props) {
          var t = props.t, tab = props.tab, onSubmit = props.onSubmit, onCancel = props.onCancel
          var entry = props.entry || null
          var editing = !!entry
          var idS = useState(entry ? String(entry.id) : ''), id = idS[0], setId = idS[1]
          var nameS = useState(entry ? String(entry.serverName || '') : ''), name = nameS[0], setName = nameS[1]
          var trS = useState(entry && entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio')
          var transport = trS[0], setTransport = trS[1]
          var cmdS = useState(entry ? String(entry.command || '') : ''), cmd = cmdS[0], setCmd = cmdS[1]
          var urlS = useState(entry ? String(entry.url || '') : ''), url = urlS[0], setUrl = urlS[1]
          var cwdS = useState(entry ? String(entry.cwd || '') : ''), cwd = cwdS[0], setCwd = cwdS[1]
          var toS = useState(entry && entry.toolCallTimeoutMs != null ? String(entry.toolCallTimeoutMs) : '')
          var timeout = toS[0], setTimeoutMs = toS[1]
          var argsS = useState(entry && entry.args && entry.args.length ? entry.args.map(String) : [''])
          var argsRows = argsS[0], setArgsRows = argsS[1]
          var envS = useState(entry ? kvInit(entry.env) : [{ k: '', v: '' }]), envRows = envS[0], setEnvRows = envS[1]
          var hdrS = useState(entry ? kvInit(entry.headers) : [{ k: '', v: '' }]), hdrRows = hdrS[0], setHdrRows = hdrS[1]
          var descS = useState(''), desc = descS[0], setDesc = descS[1]
          var ferrS = useState(''), ferr = ferrS[0], setFerr = ferrS[1]

          function submit(e) {
            e.preventDefault()
            setFerr('')
            if (tab !== 'mcp') {
              if (!id.trim()) { setFerr(t('needId')); return }
              onSubmit({ action: 'create_skill', name: id.trim(), description: desc || id.trim() }, 'create_skill ' + id.trim())
              return
            }
            if (!editing && !id.trim()) { setFerr(t('needId')); return }
            var sn = name.trim() || (editing ? String(entry.serverName || entry.id) : id.trim())
            var toNum = null
            if (timeout.trim()) {
              toNum = Number(timeout.trim())
              if (!isFinite(toNum) || toNum <= 0) { setFerr(t('badTimeout')); return }
            }
            if (transport === 'stdio' && !cmd.trim()) { setFerr(t('needCmd')); return }
            if (transport === 'streamable-http' && !url.trim()) { setFerr(t('needUrl')); return }
            var args = argsRows.filter(function (s) { return s !== '' })
            var env = kvObj(envRows)
            var headers = kvObj(hdrRows)
            if (editing) {
              // 只提交变更字段：未碰的字段不进 patch，diff 保持最小；null = 清字段
              var patch = {}
              if (sn !== String(entry.serverName || '')) patch.serverName = sn
              if (transport !== entry.transport) patch.transport = transport
              if (toNum !== (entry.toolCallTimeoutMs == null ? null : entry.toolCallTimeoutMs)) patch.toolCallTimeoutMs = toNum
              if (transport === 'stdio') {
                if (cmd !== String(entry.command || '')) patch.command = cmd
                if (JSON.stringify(args) !== JSON.stringify((entry.args || []).map(String))) patch.args = args.length ? args : null
                if (JSON.stringify(env) !== JSON.stringify(entry.env || {})) patch.env = Object.keys(env).length ? env : null
                if ((cwd.trim() || null) !== (entry.cwd == null ? null : String(entry.cwd))) patch.cwd = cwd.trim() || null
              } else {
                if (url !== String(entry.url || '')) patch.url = url
                if (JSON.stringify(headers) !== JSON.stringify(entry.headers || {})) patch.headers = Object.keys(headers).length ? headers : null
              }
              if (!Object.keys(patch).length) { setFerr(t('noChange')); return }
              onSubmit({ action: 'update_mcp', id: entry.id, entry: patch }, 'update_mcp ' + entry.id)
            } else {
              var entryNew = { id: id.trim(), serverName: sn, transport: transport, toolCallTimeoutMs: toNum == null ? undefined : toNum }
              if (transport === 'stdio') {
                entryNew.command = cmd; entryNew.args = args; entryNew.env = env; entryNew.cwd = cwd.trim() || undefined
              } else {
                entryNew.url = url; entryNew.headers = headers
              }
              onSubmit({ action: 'add_mcp', entry: entryNew }, 'add_mcp ' + id.trim())
            }
          }

          return h('form', { className: 'da-card', onSubmit: submit },
            h('div', { className: 'da-form-title' },
              tab === 'mcp' ? (editing ? t('editMcp') + ' · ' + id : t('add')) : t('create')),
            h('div', null, h('label', null, t('id'), h('input', { className: 'da-in', value: id, disabled: editing, onChange: function (e) { setId(e.target.value) }, placeholder: tab === 'mcp' ? 'mcp-my-server' : 'my-skill' }))),
            tab === 'mcp'
              ? h('div', null,
                  h('label', null, t('name'), h('input', { className: 'da-in', value: name, onChange: function (e) { setName(e.target.value) }, placeholder: 'serverName' })),
                  h('div', { className: 'da-radio' },
                    h('label', null, h('input', { type: 'radio', name: 'da-transport', checked: transport === 'stdio', onChange: function () { setTransport('stdio') } }), 'stdio'),
                    h('label', null, h('input', { type: 'radio', name: 'da-transport', checked: transport === 'streamable-http', onChange: function () { setTransport('streamable-http') } }), 'streamable-http')),
                  transport === 'stdio'
                    ? h('div', null,
                        h('label', null, t('cmd'), h('input', { className: 'da-in', value: cmd, onChange: function (e) { setCmd(e.target.value) }, placeholder: 'npx / node / C:\\Program Files\\…\\node.exe' })),
                        h('label', null, t('args')),
                        h(ArgRows, { rows: argsRows, onChange: setArgsRows, t: t, placeholder: 'arg' }),
                        h('label', null, t('env')),
                        h(KvRows, { rows: envRows, onChange: setEnvRows, t: t }),
                        h('label', null, t('cwd'), h('input', { className: 'da-in', value: cwd, onChange: function (e) { setCwd(e.target.value) } })))
                    : h('div', null,
                        h('label', null, t('url'), h('input', { className: 'da-in', value: url, onChange: function (e) { setUrl(e.target.value) }, placeholder: 'https://example.com/mcp' })),
                        h('label', null, t('headers')),
                        h(KvRows, { rows: hdrRows, onChange: setHdrRows, t: t })),
                  h('label', null, t('timeout'), h('input', { className: 'da-in', value: timeout, onChange: function (e) { setTimeoutMs(e.target.value) }, placeholder: '120000' })))
              : h('div', null, h('label', null, t('desc'), h('input', { className: 'da-in', value: desc, onChange: function (e) { setDesc(e.target.value) } }))),
            ferr ? h('div', { className: 'da-err' }, ferr) : null,
            h('button', { className: 'da-btn pri', type: 'submit' }, t('dryRun')),
            ' ', h('button', { className: 'da-btn', type: 'button', onClick: onCancel }, t('cancel')))
        }

        function PendingCard(props) {
          var p = props.pending, t = props.t
          return h('div', { className: 'da-card' },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, p.done ? t('result') : t('confirmTitle')),
            h('div', { style: { opacity: .65, fontSize: 12, marginBottom: 8 } }, p.done ? p.label : t('confirmBody')),
            h('pre', { className: 'da-pre' }, JSON.stringify(p.preview, null, 2)),
            p.done
              ? h('button', { className: 'da-btn pri', onClick: props.onClose }, t('close'))
              : h('div', null,
                  h('button', { className: 'da-btn pri', disabled: props.busy, onClick: props.onConfirm }, t('confirm')),
                  ' ', h('button', { className: 'da-btn', onClick: props.onClose }, t('cancel'))))
        }

        // Skills 详情抽屉：frontmatter 原文 + SKILL.md 正文（只读）
        function SkillDetail(props) {
          var d = props.detail, t = props.t
          return h('div', { className: 'da-card' },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
              h('span', { style: { fontWeight: 600 } }, t('detail') + ' · ' + String(d.name || '')),
              h('button', { className: 'da-btn', onClick: props.onClose }, t('close'))),
            d.loading ? h('div', null, t('loading'))
              : d.missing ? h('div', { className: 'da-err' }, t('notFound') + ': ' + String(d.name || ''))
              : d.error ? h('div', { className: 'da-err' }, d.error)
              : h('div', null,
                  d.description ? h('div', { style: { marginBottom: 6 } }, d.description) : null,
                  h('div', { className: 'da-meta' },
                    h('span', null, t('source'), ': ', String(d.source || '—'), d.rootLabel ? ' · ' + d.rootLabel : ''),
                    h('span', null, t('modelInvocable'), ': ', t(d.modelInvocable === false ? 'disabled' : 'enabled')),
                    h('span', null, t('userInvocable'), ': ', t(d.userInvocable === false ? 'disabled' : 'enabled'))),
                  d.whenToUse ? h('div', { style: { marginBottom: 6 } }, t('whenToUse'), ': ', d.whenToUse) : null,
                  d.shadowed ? h('div', { className: 'da-err' }, t('shadowed'), ': ', String(d.shadowedBy || '')) : null,
                  h('div', { className: 'da-mono', style: { opacity: .65, marginBottom: 8 } }, String(d.path || '')),
                  d.rawFrontmatter
                    ? h('div', null,
                        h('div', { style: { fontWeight: 600, margin: '6px 0 4px' } }, 'Frontmatter'),
                        h('pre', { className: 'da-pre' }, String(d.rawFrontmatter)))
                    : null,
                  h('div', { style: { fontWeight: 600, margin: '6px 0 4px' } }, t('body')),
                  h('pre', { className: 'da-pre', style: { maxHeight: '420px' } }, String(d.body || d.content || ''))))
        }

        function PanelIcon(iconProps) {
          var size = (iconProps && iconProps.size) || 20
          var active = !!(iconProps && iconProps.active)
          return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
            stroke: active ? '#5b9dff' : 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
            h('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
            h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
            h('path', { d: 'M14 17.5h7M17.5 14v7' }))
        }

        return {
          inject: ['slots', 'locale'],
          apply: function (ctx) {
            try {
              ctx.effect(function () {
                return ctx.locale.register(NS, { zh: ZH, en: EN })
              })
              var t = function (k) {
                try { return ctx.locale.resolveText({ ns: NS, key: k }) || ZH[k] || k } catch (e) { return ZH[k] || k }
              }
              // 左侧栏全局面板入口（id 必须与 main 面板 key 一致）
              ctx.effect(function () {
                return ctx.slots.inject('sidebar.panellist', function () {
                  return ctx.slots.register({
                    name: 'sidebar.panellist',
                    id: PANEL_ID,
                    order: 900,
                    locale: NS,
                    label: function () { return t('panel') }
                  }, PanelIcon)
                })
              })
              // 主区域独立面板（keyed slot，key = 面板 id）
              ctx.effect(function () {
                return ctx.slots.inject('main', function () {
                  return ctx.slots.register({
                    name: 'main',
                    key: PANEL_ID,
                    locale: NS
                  }, function (props) { return h(AdminPage, Object.assign({}, props, { t: t })) })
                })
              })
            } catch (e) {
              try { ctx?.logger?.warn?.('[dsh-admin] client 装载降级：' + String(e && e.message || e)) } catch (_) {}
            }
          }
        }
      }
    })
  }

  try { boot() } catch (e) { /* 绝不抛给 DSH */ }
})()
