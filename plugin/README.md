# MCP-Skills-DSH

> npm 包名：`mcp-skills-dsh`（npm 强制小写）。界面显示名 / 左侧栏入口为 **MCP-Skills-DSH**。

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 内直接管理 **MCP 服务** 与 **Skills** 的插件。装完会多出一个左侧栏入口和独立管理页，不再是插件详情页的一张说明卡片。

## 功能

- **左侧栏独立入口 + 独立管理页**：MCP / Skills 两个 tab，列表、启停、新增、删除、刷新。
- **Host 半**：注册 `dsh_admin` 工具，并挂载同源 HTTP API `/dsh-admin/api` 供页面调用（复用 `connection.admit` 鉴权）。
- **写操作默认 dry-run**：先出 diff 预览，点「确认应用」才落盘；写入自动备份、原子写、失败回滚。
- **运行时探测**：`runtime_list` / `runtime_probe` / `runtime_restart` 查看 MCP 连接状态并重启，失败静默降级。
- **自包含**：`lib/*.mjs` + `vendor/yaml/` 全部随包分发，`dependencies: {}`，运行时零外部依赖、启动零网络请求。

## 兼容性

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | `>=0.2.2-rc.1 <0.3.0`（`engines.dsh`） |
| Node.js | `>=22` |
| 平台 | Web / Desktop 的 Host（需要 `tools`、`webServer`、`connection` 服务） |

## 安装

```bash
dsh plugin --profile web add mcp-skills-dsh
```

或指定版本 / 本地 tarball：

```bash
dsh plugin --profile web add mcp-skills-dsh@0.6.1
dsh plugin --profile web add ./mcp-skills-dsh-0.6.1.tgz
```

`desktop` profile 由产品侧托管，`dsh` CLI 会拒绝写入；请装到 `web` / `headless` 等可管理的 profile，或由 profile 配置工具合并 `cordis.patch.yml` 并登记依赖。

> 插件 JS 是 ESM 模块，存在模块缓存；**新增或升级后需重启 DSH 进程**才生效（配置型 patch 可热加载，代码不行）。

## 管理目标

插件默认管理**当前 DSH 实例**的 `$DSH_HOME` 与 profile。若要让页面管理另一个配置目录（例如桌面版的配置），在启动 DSH 时显式指定：

```bash
DSH_ADMIN_HOME=/path/to/.dsh DSH_ADMIN_PROFILE=desktop \
  dsh --profile web --no-open --port 18080
```

`status` 响应会回显实际生效的 `dshHome` / `profile`，操作前请先确认。

## 工具用法（`dsh_admin`）

会话中可直接让模型调用，参数：`action`(enum) / `target` / `id` / `name` / `enabled` / `confirm` / `entry`(object) / `description`。

只读 / 导出：

```
dsh_admin {"action":"status"}
dsh_admin {"action":"list_mcp"}
dsh_admin {"action":"get_mcp","id":"mcp-exa"}
dsh_admin {"action":"list_skills"}
dsh_admin {"action":"get_skill","name":"alpha-skill"}
dsh_admin {"action":"validate_mcp"}
dsh_admin {"action":"export_skills"}
```

写操作（**默认 dry-run**，`confirm:true` 才落盘）：

```
dsh_admin {"action":"set_mcp_enabled","id":"mcp-exa","enabled":false}                       # 只预览
dsh_admin {"action":"set_mcp_enabled","id":"mcp-exa","enabled":false,"confirm":true}       # 真正写入
dsh_admin {"action":"add_mcp","entry":{"id":"mcp-ro","serverName":"ro","transport":"stdio","command":"node"},"confirm":true}
dsh_admin {"action":"create_skill","name":"my-skill","description":"示例","confirm":true}
dsh_admin {"action":"remove_mcp","id":"mcp-ro","confirm":true}
dsh_admin {"action":"import_skills","entry":{...},"confirm":true}
```

| 类型 | actions |
| --- | --- |
| 只读 | `status` `list_mcp` `get_mcp` `list_skills` `get_skill` `validate_mcp` `export_skills` `runtime_list` `runtime_probe` |
| 写 | `set_mcp_enabled` `set_skill_enabled` `add_mcp` `update_mcp` `remove_mcp` `create_skill` `remove_skill` `import_skills` `runtime_restart` |

MCP 条目格式遵循 Harness 的 `dsh-mcp-client`：`transport` 仅 `stdio` / `streamable-http`，`serverName` 匹配 `^[A-Za-z0-9_-]{1,32}$`。Skills 是 `<name>/SKILL.md` 目录 + YAML frontmatter。

## 安全说明

- **写默认 dry-run**：`confirm !== true` 只返回 diff 预览，绝不落盘。
- **写入可回滚**：统一走 `lib/yaml-io.mjs` 的 `commitFile` —— 写前 `.bak-YYYYMMDD-HHmmss` 备份、`.tmp` 原子写 rename、写后回读校验、失败从备份回滚；删除 skill 走「移到备份目录」而非硬删。
- **路径安全**：skills 扫描锚定 `DSH_ADMIN_HOME`，配合 `assertWithin` / `isSafeName` 防目录穿越；HTTP API 经 `connection.admit(req)` 鉴权（未认证返回 401）。
- **故障隔离**：`apply()` 顶层 try/catch，异常只写日志、不阻塞 Harness 装载；`config.enabled:false` 可熔断。
- **无外链跳转**：client 半完全在 Harness 内渲染。

## 组成

| 路径 | 作用 |
| --- | --- |
| `index.js` | host 半：`export name/inject/apply`，注册 `dsh_admin` 工具 |
| `host-api.js` | 挂载同源 HTTP API `/dsh-admin/api` |
| `runtime.js` | MCP 运行时探测 / 重启（`mcpManager` → mcp-client fiber → 工具前缀计数兜底） |
| `client.js` | `sidebar.panellist` 左侧栏入口 + `main` keyed 面板（React 组件） |
| `cordis.patch.yml` | `insert` 一条 host 行：`id: dsh-admin` / `inject:[tools]` / `config.enabled:true` |
| `lib/` | 5 个 `.mjs` 纯函数（MCP/skills 读写、YAML AST 改写、路径） |
| `vendor/yaml/` | vendored yaml@2.9.1 运行时（ISC，见 `THIRD_PARTY_NOTICES.md`） |
| `locale/*.json` | 中英文案 |

## 许可证

MIT。第三方声明见 `THIRD_PARTY_NOTICES.md`。
