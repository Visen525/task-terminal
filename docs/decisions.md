# 决策记录

每个里程碑追加 3–5 行：为什么这么做。给未来的自己（和贡献者）看。

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
