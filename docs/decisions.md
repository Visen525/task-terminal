# 决策记录

每个里程碑追加 3–5 行：为什么这么做。给未来的自己（和贡献者）看。

## M3-01 executeTool 单一出口与路径校验（2026-10-24）

- **路径判定顺序固定为：权限 → UNC/设备路径预检 → resolve → 最深存在祖先 realpath → 拼回不存在尾段 → 大小写归一化前缀比较**。先 realpath 再比较，才能让 symlink、`\\?\` 扩展前缀和 8.3 短名都落在真实目标上；不存在的新文件（未来 `write_file`）用“最深存在祖先 + 剩余相对段”解析，不会因 realpath 抛 ENOENT 而误判。Windows 比较前统一转小写并归一化分隔符；工作区根由 `createToolContext` 启动时 realpath 一次并缓存。percent 解码最多三层，原文和每一层解码形态都校验，避免 `%2e%2e%2f` 类编码变体绕过。
- **硬拒绝的判定顺序：read-only 权限 → argv 形状 → argv[0] basename 硬拒绝清单 → reg delete / cipher /w / powershell EncodedCommand → shell 命令串（管道、内层硬拒绝命令、内层删除族）→ 删除族路径参数 → cwd 路径 → spawn**。所有拒绝都在创建输出文件与 spawn 之前完成；危险命令无论 cwd 是否合法都先拒。shell 串里的管道一律拒，即使管道字符出现在引号里也保守拒绝。
- **删除族（del/erase/rd/rmdir/rm）的保守规则**：所有非开关参数都当路径校验；Windows 的 `/s` `/q` 等开关跳过，`-` 开头按文件名校验；POSIX 的 `-rf` 等开关跳过，`--` 之后全部按路径校验。通配符和 `%VAR%`/`$VAR` 按字面量解析，能识别的 `..`、绝对路径、UNC、`\\?\` 逃逸都会拒；工作区根自身也不允许交给删除族。shell 串内对每个 token 都按硬拒绝/删除词匹配（宁可误拒 `echo format`），并额外识别 PowerShell 的 `Remove-Item`/`ri`，以覆盖 `call`/`start`/嵌套 powershell 等包装。局限：参数解析仍无法覆盖解释器（如 `node -e`、`python` 自行删文件）、复杂变量展开和未列出的删除 API；被 shell 包裹的删除族因此**一律拒绝**而不是尝试解析。硬拒绝是纵深防御，不是 OS 沙箱。
- **超时默认 120s（SPEC 未单列工具超时，与 provider 读取超时对齐）**，到点执行 `taskkill /PID <pid> /T /F`；若受限环境 taskkill 不可用则退回 `child.kill('SIGKILL')`。stdout/stderr 用临时文件描述符收集而不是 pipe：受限执行环境可能禁止创建命名管道（本机验收时 spawn pipe 会 EPERM），且全量输出本来就要落盘到 `data/tool-outputs/<runId>/`，文件方式同时避免管道背压。
- **返回输出 >200KB 时保留头尾并注明截断，全量原文单独落盘；事件无论成败都严格一对**（`agent.tool_call` + `agent.tool_result`，失败结果带 `code`；非零退出用本地结果码 `E_TOOL_EXIT`，不扩展 core 错误码）。本卡只内建 `read_file` / `run_command` 两个验收载体，写路径权限校验通过导出的 `resolveWorkspacePath(..., 'write')` 提供给 M3-02 的 `write_file` 等工具复用，避免提前复制六个工具。

## M2-01 DeepSeek 适配（2026-10-24）

- **不引 SDK，直接用 Node 24 内置 fetch**：只有 chat / stream / balance 三个端点，适配层自己控制超时、重试和脱敏；少一个依赖面，也不会把 SDK 的默认重试行为混进我们的策略。
- **流式事件设计为 `text_delta` / `tool_call_delta` / `done` 三态**：文本增量立即给 UI；tool_call 只给分片，`done.response` 才是唯一完整结果，`LlmToolCall.function.arguments` 在 `done` 之前绝不交付，M3 loop 只需在 `done` 上做 JSON.parse 和工具执行。
- **重试与超时分离**：429/500/503 指数退避（默认 3 次，基数可注入，尊重 Retry-After）；超时用内部 AbortController 映射为 `E_PROVIDER_TIMEOUT`，调用方 `AbortSignal` 中止保留 `AbortError`，避免把“用户取消”误记成服务故障。
- **usage 缺失才估算**：有 `prompt_tokens` / `completion_tokens` 时原样映射，`prompt_cache_hit_tokens` 缺省为 0；整段或字段缺失时按字符数/2 估算并置 `estimated=true`，保证记账永远有值且可辨认来源。
- **假 provider 与 mock server 分开**：verify 用 `FakeProvider` 覆盖 M3 需要的脚本化场景，DeepSeek 的 HTTP/SSE 细节用 127.0.0.1 随机端口 mock server 验证；两者都不碰真 API，也不新增依赖。

## M1-02 标题/摘要写入与 FTS 索引（2026-10-24）

- **FTS 同步选方案 B（应用层双写，migrate.ts 不动）**：产物只有 `store/artifacts.ts` 一个写入口，主表与 `artifact_fts` 放在同一事务里即可保证原子性；不改 `SCHEMA_VERSION`，避免在“v1 DDL 冻结”的前提下引入 v2 升级与旧数据回填风险。代价是绕过 `insertArtifact` 直接 INSERT artifacts 不会自动进索引，因此仓储层约定为唯一写入口。
- **tags / findings 原样索引 JSON 数组文本**：`artifact_fts` 是 `content='artifacts'` 的外部内容表，索引值必须与主表列值完全一致，`rebuild` 与外部内容 `delete` 才不会失配；因此不做“拼接成空格分隔字符串”的转换，中文仍能被 trigram 切到。
- **更新先 delete 旧索引值，再改主表、再写新索引**：外部内容 FTS 的 `delete` 命令要求提供索引时的旧列值；三步同事务执行，旧关键词在提交后立即消失，不会出现主表已改、索引仍残留的窗口。
- **检索按词长分流**：所有词 ≥3 字时走 FTS5 `MATCH`（每个词加引号转义成短语，词间 AND）+ `bm25()` 升序 + `snippet(-1, '[', ']', '…', 32)`；任一词 <3 字时 trigram 无法 MATCH（验收示例“环比”只有 2 字），退化为对 title/summary/tags/findings 四列做 `instr` 过滤并按字段命中加权排序、手工加高亮。两条路径都只碰这四个检索列，正文/path 不参与索引。
- **verify 仍只用临时目录库**：新增用例全部走 `mkdtemp` + `openDatabase`，不产生 `data/` 残留；迁移健壮性用新库连续调用 `migrate()` 覆盖，未引入触发器，因此 v1→v2 升级用例不适用。

## M1-01 事件流与 foldEvents（2026-10-23）

- **events 采用方案 A（实现迁到 `store/events.ts`，`repo.ts` re-export）**：事件流是 SSE / runtime 的稳定模块边界，行映射与分页 SQL 放在一起便于独立演进；re-export 保证 M0 的 `repo.appendEvent/listEvents` 调用方零改动，也避免两处实现漂移。
- **`foldEvents` 只做纯折叠**：先复制并按 `seq` 升序排序，`task.created` 是最初事件（初始状态 queued）；`task.queued` 在 queued 下作为幂等标记，failed → queued 视为重试并递增 attempt。
- **状态变更全部复用 `assertTransition`**：缺 `task.started`、终态后复活、跳过合法中间态等一律抛 `ContractError(E_INVALID_TRANSITION)`；`task.started` 同时承担 waiting_input → running 的恢复。
- **waiting_input 的事件约定**：契约冻结的 15 种事件里没有单独状态事件，因此用 `agent.tool_call{tool:'ask_user'}` 表示进入 waiting_input；回复后的恢复由 `task.started` 表达。活动事件只在 running 接受，`memory.fact_upserted` 是跨任务事实、不参与任务状态。
- **verify 脚本用 `node --test --test-isolation=none`**：Node 24 测试运行器默认再 spawn 子进程，在受限 Windows 环境下会因管道 EPERM 失败；进程内隔离不改变断言内容，也让 m0/m1 在同一命令中稳定运行。

## M0-03 数据库迁移与仓储（2026-10-23）

- **驱动用 Node 24 内置 `node:sqlite`，不引 better-sqlite3**：本机 spike 验证 WAL、FTS5、trigram 全可用（SQLite 3.53.4），零新依赖、零 native 编译；`@types/node` 自带类型。若后续遇到内置 API 缺口再评估切换（切换成本隔离在 store 层）。
- **迁移用 `schema_migrations` 版本表 + 幂等 DDL**：重复打开同一库不报错；DDL 在 `BEGIN IMMEDIATE` 事务内执行。
- **events append-only 用数据库触发器兜底**：`events_no_update` / `events_no_delete`，代码层不提供改删 API，运行期无法绕过。
- **ULID 自行实现（26 位 Crockford Base32）**：白名单虽允许 `ulid` 包，但 30 行可测代码即可，少一个依赖面；ID 前缀 `t_` / `r_` 由仓储层加。
- **仓储层只给原语**：「状态变更同时写事件」的编排放在 runtime（SPEC §4.3），M0-03 不把事件编排塞进 repo。

## M0-02 契约层（2026-10-23）

- **状态机用常量数组 + 纯函数，不用 enum**：`erasableSyntaxOnly` 禁止 enum；数组可被验收脚本直接遍历，转移表本身就是文档。
- **终态无出边**：SPEC §7 M0-02 写"每个状态至少有一条合法出边"，与 §4.3 的终态定义冲突；按语义取"非终态有出边、终态无出边"，验收脚本按此断言。
- **`canTransition` 返回 boolean + `assertTransition` 抛 `ContractError`**：同时满足"非法转移一律抛错"与"非法转移可判假"两条要求。
- **契约层零依赖零 IO**：只放类型、常量、纯函数，为 M0-03 之后各层提供稳定接口；ULID 生成属于 IO 相关实现，放到 store 层。
- **Run 转移按最小集**：SPEC 未给 run 转移表，取 `running → completed|failed|interrupted|cancelled`，终态不再复活（重试 = 新 run）。

## M0-01 仓库骨架（2026-10-23）

- **单包结构（`src/` 分目录）而非 pnpm workspace**：workspace 链接与包名解析要额外配置，
  出错时很难查；Node 24 原生支持运行 `.ts`，单包 + 相对路径最稳。
- **测试用内置 `node:test`，不引 vitest/tsx**：Node 24 直接跑 `.ts`，零构建步骤、零额外依赖。
- **不引 eslint**：`tsc --noEmit` + 验收脚本已覆盖主要问题，少一个配置面就少一处故障。
- **导入路径一律带 `.ts` 后缀**：这是 Node 原生运行 TypeScript 的要求，也让路径可点击跳转。
- **只用可擦除语法**：不用 `enum` / `namespace` / 构造器参数属性，否则 Node 无法直接运行。
