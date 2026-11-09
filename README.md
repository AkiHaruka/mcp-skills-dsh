# MCP-Skills-DSH

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里直接管理 **MCP 服务**与 **Skills** 的插件，附带一套同样能力的本地 CLI。

- **插件**（[plugin/](plugin/)）：左侧栏独立入口 + 独立管理页，MCP / Skills 两个 tab，支持列表、启停、新增、删除、刷新与运行时探测。
- **CLI**（[bin/dsh-admin.mjs](bin/dsh-admin.mjs)）：零框架 ESM，默认只读，`--apply` 才落盘，适合脚本化与本地排查。

npm 包名：`mcp-skills-dsh`（npm 强制小写）。界面显示名 / 左侧栏入口为 **MCP-Skills-DSH**。

## 功能

- **左侧栏独立入口 + 独立管理页**：MCP / Skills 分 tab，列表、启停、新增、删除、刷新。
- **Host 半**：注册 `dsh_admin` 工具，并挂载同源 HTTP API `/dsh-admin/api` 供页面调用（复用 `connection.admit` 鉴权）。
- **写操作默认 dry-run**：先出 diff 预览，点「确认应用」才落盘；写入自动备份、原子写、失败回滚。
- **运行时探测**：`runtime_list` / `runtime_probe` / `runtime_restart` 双层覆盖（`mcpManager` 服务 → mcp-client fiber → 工具前缀计数兜底），失败静默降级。
- **自包含**：`plugin/lib/*.mjs` + `plugin/vendor/yaml/` 全部随包分发，`dependencies: {}`，运行时零外部依赖、启动零网络请求。

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

### 兼容性

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | `>=0.2.2-rc.1 <0.3.0`（`engines.dsh`） |
| Node.js | `>=22`（CLI 与测试可运行在 Node ≥ 18） |
| 平台 | Web / Desktop 的 Host（需要 `tools`、`webServer`、`connection` 服务） |

### 管理目标

插件默认管理**当前 DSH 实例**的 `$DSH_HOME` 与 profile。若要让页面管理另一个配置目录（例如桌面版配置），启动 DSH 时显式指定：

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
dsh_admin {"action":"runtime_list"}
dsh_admin {"action":"runtime_probe","name":"exa"}
```

写操作（**默认 dry-run**，`confirm:true` 才落盘）：

```
dsh_admin {"action":"set_mcp_enabled","id":"mcp-exa","enabled":false}                       # 只预览
dsh_admin {"action":"set_mcp_enabled","id":"mcp-exa","enabled":false,"confirm":true}       # 真正写入
dsh_admin {"action":"add_mcp","entry":{"id":"mcp-ro","serverName":"ro","transport":"stdio","command":"node"},"confirm":true}
dsh_admin {"action":"create_skill","name":"my-skill","description":"示例","confirm":true}
dsh_admin {"action":"remove_mcp","id":"mcp-ro","confirm":true}
dsh_admin {"action":"import_skills","entry":{...},"confirm":true}
dsh_admin {"action":"runtime_restart","name":"exa","confirm":true}
```

| 类型 | actions |
| --- | --- |
| 只读 | `status` `list_mcp` `get_mcp` `list_skills` `get_skill` `validate_mcp` `export_skills` `runtime_list` `runtime_probe` |
| 写 | `set_mcp_enabled` `set_skill_enabled` `add_mcp` `update_mcp` `remove_mcp` `create_skill` `remove_skill` `import_skills` `runtime_restart` |

MCP 条目格式遵循 Harness 的 `dsh-mcp-client`：`transport` 仅 `stdio` / `streamable-http`，`serverName` 匹配 `^[A-Za-z0-9_-]{1,32}$`。Skills 是 `<name>/SKILL.md` 目录 + YAML frontmatter。

## CLI（本地管理，默认只读）

环境：Windows / macOS / Linux，Node ≥ 18，依赖仅 `yaml`。

```bash
npm install

# 状态（JSON）
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop --json status
# 列出 MCP / skills
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop mcp list
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop skills list
# 查看单条
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop mcp show mcp-snowluma
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop skills show alpha-skill
```

**写操作预览（默认，不落盘）**：

```bash
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop mcp enable mcp-exa
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop skills disable alpha-skill
```

**真正写入**（加 `--apply`）：

```bash
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop --apply mcp enable mcp-exa
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop --apply \
  mcp add --id mcp-demo --name demo --transport stdio --command node --args demo.js
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop --apply \
  skills create demo-skill --description "示例技能"
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop --apply skills export out.json
node bin/dsh-admin.mjs --dsh-home test/fixtures --profile desktop --apply skills import out.json
```

其他子命令：`mcp update|remove|disable|validate`、`skills enable|remove`。
全局参数：`--dsh-home <path>`、`--profile <name>`、`--json`、`--dry-run`、`--apply`、`--yes`、
`--project-root <p>`、`--agents-home <p>`、`--extra-root <p>`。

## 安全机制

- **写默认 dry-run**：`confirm !== true`（CLI 为缺少 `--apply`）只返回 diff 预览，绝不落盘。
- **写入可回滚**：统一走 `lib/yaml-io.mjs` 的 `commitFile` —— 写前 `.bak-YYYYMMDD-HHmmss` 备份、`.tmp` 原子写 rename、写后回读校验、失败从备份回滚；删除 skill 走「移到备份目录」而非硬删。
- **绝不默认写真实 `~/.dsh`**：CLI / 管理页一律用 `--dsh-home` / `DSH_ADMIN_HOME` 指向目标；测试全部用 `fs.mkdtemp` 临时目录。
- **路径安全**：skills 扫描锚定 DSH 主目录，配合 `assertWithin` / `isSafeName` 防目录穿越；HTTP API 经 `connection.admit(req)` 鉴权（未认证返回 401）。
- **故障隔离**：`apply()` 顶层 try/catch，异常只写日志、不阻塞 Harness 装载；`config.enabled:false` 可熔断。
- **不启动/重启 DSH、不碰外部服务器、不 `npm publish`**（发布脚本需人工执行）。

## 关键机制

- **YAML round-trip**：用 `yaml` 包的 `parseDocument` 建 AST，在 AST 上做 `set/delete/splice`，再 `toString({lineWidth:0})` 输出。注释、键顺序、单引号、块标量、以及 DSH 的 `!!js` 惰性表达式节点都会原样保留（`!!js` 被当作带 tag 的 Scalar，不求值、不重排）；`lineWidth:0` 防止长 URL 被折行。
- **MCP 两类条目**：`@deepseek-ai/dsh-mcp-client` 静态行、以及 `@deepseek-ai/dsh-mcp-manager` 的 `config.servers` dict。启停用顶层 `- id: <id>` + `disabled: true` 覆盖行，不删原配置。
- **skills 启停**：读取时 `yaml.parse` 解析 frontmatter（正确处理 `>` 折叠块 / `|` 块 / 引号）；写入时**不重新序列化整个 frontmatter**，而是文本级只替换 `disable-model-invocation` / `user-invocable` 两行，其余 frontmatter 与 Markdown 正文按字节原样拼回。
- **skills roots**：`<project>/.dsh/skills`(100) → `.agents/skills`(200) → custom(300) → `<dshHome>/skills`(400) → `<agentsHome>/skills`(500) → bundled(600)，数字小者优先，重名标注被遮蔽。

## 目录结构

```
package.json              根工作区：CLI 脚本 test / check，依赖仅 yaml
bin/dsh-admin.mjs         CLI（默认只读）
lib/                      paths / yaml-io / mcp / skills 纯函数
test/                     node --test 测试 + fixtures
plugin/                   可安装的 DSH bundle（npm 包 mcp-skills-dsh）
  index.js                host 半：export name/inject/apply，注册 dsh_admin 工具
  host-api.js             同源 HTTP API /dsh-admin/api
  runtime.js              MCP 运行时探测 / 重启（双层覆盖 + 零依赖兜底）
  client.js               左侧栏入口 + 独立管理页（React 组件）
  cordis.patch.yml        insert 一条 host 行
  lib/ vendor/ locale/    插件内自包含运行时与文案
publish.ps1               npm 发布脚本（人工执行）
```

## 开发与测试

```bash
npm install
npm test                                  # 31 项：MCP / skills / CLI
node plugin/test/isolation.check.mjs      # 插件自包含检查

cd plugin
npm test                                  # 20 项：离线 + runtime
```

测试一律使用 `fs.mkdtemp` 临时目录或 `test/fixtures`，**不触碰真实 `~/.dsh`**。

## 已知限制

- 管理页的写操作目前覆盖 MCP / Skills 的增删启停；更细粒度的配置编辑请用 CLI。
- `listMcp` 对 `mcp-manager.servers` 按 dict key 推断 `serverName`；若某项自带 `serverName` 以其为准。
- `runtime_*` 依赖 `mcpManager` 服务或 mcp-client fiber 的运行时形态，DSH 版本变化时可能降级为「只能数工具」。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方声明见 [plugin/THIRD_PARTY_NOTICES.md](plugin/THIRD_PARTY_NOTICES.md)。
