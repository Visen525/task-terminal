# 决策记录

每个里程碑追加 3–5 行：为什么这么做。给未来的自己（和贡献者）看。

## M9-02 设置面板与记忆管理（2026-10-24）

- **事实列表与删除放在 `store/facts.ts` 的两个新函数里，路由只做整形**：`listFacts` 默认 `superseded_by IS NULL`，开关打开时返回全部，并固定按 `scope/key` 排序，界面不依赖 `recallFacts` 的 confidence 排序；`deleteFact` 返回真实删除行数，`0` 由路由映射为 404。事实 id 统一为 `f_` + 26 位 ULID，非法格式在进入 SQL 前直接 400，错误文案不回显输入。
- **删除的悬挂清理与删除在同一事务内完成**：先 `UPDATE ... SET superseded_by = NULL WHERE superseded_by = ?`，再 `DELETE`，保证不会留下指向已删除 id 的引用。删除当前版本时上一版会重新成为有效记录（这是清链的自然结果）；代价是更长的链被删中间版本时可能出现多个候选当前行，但任务卡明确要求置 NULL 而非重接前驱/后继，故不擅自扩展语义。
- **事实删除不写事件**：`EVENT_TYPES` 是冻结清单且没有事实删除类型，`memory_facts` 也不是事件源表；硬删除只改表，设置页的统计随 COUNT 立即变化。删除接口不返回被删内容，避免把记忆正文带进日志/响应。
- **概览的四数字在 server 层做一次聚合查询，counts 各用一条 COUNT**：`getDailyUsage` 仍负责日预算的 `total`（input+output，cached 是 input 子集），另查 input/cached/output 三个 SUM；`counts.facts` 取 `memory_facts` 全表行数，因此历史版本也计入“事实”总数。`src/store/llm-calls.ts` 与 `facts.ts` 的追加边界保持不动。
- **设置做成内容区整页而非 Drawer，入口仍是侧边栏齿轮**：整页更便于“来源任务”跳转后保留极简路由，且与 M9-01 的 PageHeader/卡片/空态一致；切换“显示被取代的历史版本”才请求 `includeSuperseded=true`，避免默认把历史记录带进首屏。为了让 `pnpm dev` 的 Vite 代理能转发新路由，`vite.config.ts` 仅追加 `/facts`、`/settings` 两条代理，不新增依赖，也不改任何请求/构建行为。

## M9-01 前端视觉重构（2026-10-24）

- **主题 token 集中在 `src/web/src/theme.ts`，页面局部样式集中在 `styles.css`**：主色 `#4F46E5`、`borderRadius: 10`、`fontSize: 14`、冷灰中性色与系统字体栈只走 ConfigProvider；页面用 `--tt-*` CSS 变量复用同一套色阶，避免每个组件各写一份十六进制。重阴影全部换成 1px `#E5E7EB` 边框 + 极浅底色。
- **侧边栏 208px 浅色 + 图标菜单，内容区自带标题**：去掉全局 Header，页面标题由 `PageHeader` 组件提供；App 只负责 1080px（对话 860px）居中容器与响应式内边距。设置齿轮仅摆图标，事件留给 M9-02。
- **看板由 Table 改单列卡片；详情拆三张信息小卡；时间线改左侧竖线节点**：卡片保留 2s 轮询、新建 Modal、分页（12 条/页）与点击打开详情的原有行为；详情保留 SSE、取消/重试、自动跟随开关；时间线仍是虚拟滚动，只替换行结构与字号/间距。
- **对话与产物库只动表现层**：气泡、头像、三点动画、卡片化输入区、附件占位和产物卡片 hover 都不改 `chatApi.ts` / `artifactApi.ts` 的请求逻辑；发送仍走 24ms 合批与 disabled 逻辑。
- **构建 chunk 用 `manualChunks` 按职责拆 antd**：`antd-form`（196kB）、`antd-display`（167kB）、`antd-core`（433kB，含 React 公共运行时）、`icons`（14kB）、`markdown`（118kB）、`tanstack`（68kB）；Rolldown 会把 React 合并进 core，但已无 >500kB 单 chunk 告警。
- **验收备注（未改测试）**：`pnpm verify` 的类型检查在 v1.1 契约提交（a7f5dc34）后已有 30 处 `LlmMessage.content` 联合类型错误，全部位于未改动的 `scripts/verify/m3|m5|m7.test.ts`；运行时 156 条中 154 条通过，剩余 2 条是 M6 的依赖白名单断言尚未包含本卡要求新增的 `@ant-design/icons`。本卡遵守“既有测试不改”的边界，`src/web` 自身类型检查与构建均通过，待 Manager 授权后单独更新测试白名单/断言。

## M8-01 开源收尾（2026-10-30）

- **README 的快速开始以实际装配为准，而不是照抄 SPEC 的占位值**：端口取 `src/index.ts` 的 `DEFAULT_PORT = 4310` 与 `src/web/vite.config.ts` 的 `5173`；命令名逐条核对 `package.json` 的 `dev` / `verify` / `build`。`pnpm verify` 目前是 156 条测试，全部走假 provider，不要求真实 Key。
- **`config.example.yaml` 只做核对性修正，不删除既有段落**：启动装配当前只读 `.env` / 进程环境，完全不解析 `config.yaml`；因此不能把示例写成“可用配置”。文件保留 `server` / `model` / `prices` / `workspace` / `limits` / `data` 的 YAML 形状，每节标注「计划中，当前未生效」，并把端口从 4317 修正为实际默认 4310，同时用注释列出实际支持的环境变量（`PORT` / `WORKSPACE_DIR` / `DATA_DIR` 等）。保留段落也避免破坏 M0-01 对关键段落的既有断言。
- **不新增“配置加载器”来消除文档与实现的落差**：M8-01 的允许范围是文档与配置示例，新增加载器会扩大范围并改变启动契约；把落差写清楚，留给后续任务卡决定是否接线。README 明确 `DATA_DIR` 当前作用于 SQLite 与工具输出，note 产物默认目录仍是启动目录下的 `data/artifacts`。
- **开源四件套按“可核对”标准写**：LICENSE 用标准 MIT 全文与 `Copyright (c) 2026 Visen525`；CHANGELOG 按 Keep a Changelog 分 1.0.0 / 0.2.0 / 0.1.0；CONTRIBUTING 只保留三条硬要求（附 `pnpm verify` 输出、先读 SPEC/decisions、绝不提交密钥或个人数据）。发布 checklist 与打 tag 留给 Manager。

## M7-02 长期事实与回访链路（2026-10-29）

- **来源任务同时进搜索与读正文的结构化结果**：`search_artifacts` 每项新增 `source_task_id`（保留既有 `task_id`），`read_artifact` 的 `data` 新增 `source_task_id` 并固定返回 `kind` / `sha256`；note 的 `output` 仍是正文分页，不把元数据混进正文，模型从 `search_artifacts` 结果拿到来源 ID 后再按提示规则引用。主线提示追加第 6 条硬规则：引用产物结论必须带 `source_task_id`，未读原文要注明“根据摘要”。
- **facts 的 query 从 instr 升级为带 ESCAPE 的 LIKE**：先转义反斜杠再转义 `%` / `_`，查询 `100%` 或 `a_b` 只命中字面量，不会退化成全表匹配；`lower(key/value) LIKE lower(?)` 保留 ASCII 大小写不敏感，排序仍是 `confidence DESC, updated_at DESC`。scope 精确匹配，另支持传 `project` / `project:` 匹配全部 `project:<key>` 事实族。
- **`runMainTurn` 增加可选 `artifactsDir` 并透传 main-tools**：生产默认 `<cwd>/data/artifacts` 行为不变；验收测试必须用临时目录放 note 正文，否则 read_artifact 会去仓库 data/ 找文件，因此这个注入点是回访链路可测试性的最小缺口。
- **回访测试按真实调用序断言**：剧本 B 用 `runGuardedLoop + persistArtifacts` 造 completed 任务与 note，再用新 `FakeProvider` 走 `search_artifacts → read_artifact → 文本`；断言工具序列、`read_artifact` 的 `source_task_id/kind/sha256/offset/limit/content`、搜索结果的来源字段，以及最终回复完全来自 provider 剧本。真 API 的语义验证留给 Manager 手测。

## M7-01 产物落盘与检索（2026-10-28）

- **落盘只挂一个 loop 钩子，且必须排在 task.completed 之前**：`RunLoopOptions.onBeforeComplete` 在 submit_result 校验通过、`agent.tool_result` 写完之后同步调用；`persistArtifacts` 先写全部 `artifact.created`，最后写一条 `summary.generated`，loop 随后才写 `task.completed`。这样 foldEvents 看到的 `artifact.created` / `summary.generated` 都在 running 态，不会触发非法转移；钩子抛错复用既有 `fail('result_invalid')`，事件 payload 与返回值都带 `error_code`，不新增失败原因。
- **假完成防御采用“先全量校验、后统一落盘”的两阶段**：file/dataset/patch 先用 `createToolContext + resolveWorkspacePath`（与 executeTool 同款路径语义，但不经 executeTool）校验并读取，任何路径缺失/读失败都在写 note、插表、发事件之前抛 `E_NOT_FOUND`，避免“第一个产物成功、第二个失败”留下半落盘。模型声称产出不存在的文件按 SPEC 反假完成原则直接失败；非 note 缺 path 则是 `E_INVALID_ARGUMENT`（schema 描述“path 仅 note 可省”）。
- **note 写 `data/artifacts/<taskId>/<ulid>.md`，data/ 视为系统受信目录**：目录创建/写文件直接用 fs，不走 executeTool 的模型动作沙箱；`artifacts.path` 始终存逻辑相对路径 `data/artifacts/...`，实际根目录由 `artifactsDir` 注入（默认 `<cwd>/data/artifacts`），测试用临时目录而不在仓库留下 note 文件。Markdown 含 artifact.summary 与 result.findings，两者随 insertArtifact 进 FTS（只索引摘要/标签/findings，不索引正文）。
- **看门狗只透传钩子，装配参数留给装配层**：`runGuardedLoop` 把 `onBeforeComplete` 原样交给 `runLoop`，不在 runtime 里 import agent 落盘模块；workspace 从 task 绑定、runId/now/artifactsDir 由调用方组装。M7-01 期间 `scheduler.ts` 属冻结文件，生产调度接线留到后续装配卡；本卡用 `runGuardedLoop` 的显式钩子完成端到端验收，既有 M3-04 调用因未传钩子行为完全不变。
- **检索排序在仓储层之外做复合打分**：`searchArtifactsRanked` 先用既有 `searchArtifacts` 取 50 个候选（短词自动走 instr 退化路径），再按 bm25/字段分 min-max 归一 + `exp(-ageDays/30)*0.3` + tag 命中比例 `*0.2` 重排取 8；正文与 path 不参与索引。`read_artifact` 的 note 正文读取放在 `agent/artifacts.ts` 的受信目录 helper 里，main-tools 只调用它，既满足“note fs 直读”，也不破坏 M5 既有“main-tools 不 import node:fs”的源码断言；file/dataset/patch 只回 sha256/bytes/path，正文仍要模型用工作区 read_file 查看。

## M6-03 产物库与对话（2026-10-27）

- **POST /chat 的流式错误放在 HTTP 200 的流内**：路由先 `reply.hijack()` 写 `text/event-stream` 头，成功发 `event: delta`（`{text}`）与一条 `event: done`（`{reply, usage}`）；运行期错误发 `event: error`（`{code, message}`）后结束，不再改成 500 JSON。这样前端只需处理一种响应形态，已收到的 delta 不会因状态码切换而丢失；参数错误仍发生在建流之前，由全局错误处理器返回 400 JSON。建流后立即写一行 `: connected` 注释，既冲刷响应头让 fetch 在首 token 前拿到流，也让代理/客户端确认连接已建立。
- **main-loop 只在提供 `onTextDelta` 时改走 `provider.stream`，否则保留 `provider.chat`**：M5 既有测试里有一个只实现 chat、stream 直接抛 `stream not used` 的动态 provider；若无条件切换会破坏“M5 测试零改动全绿”。流式路径只转发 `text_delta`，完整响应仍以 `done.response` 为准，工具执行、记账、上限收口与终态语义全部复用原循环；不提供流式回调时行为与 M5 逐字一致。
- **前端 24ms 字符串缓冲合批，`done.reply` 兜底替换**：SSE 回调只做 `deltaBufferRef.current += delta`，由 24ms `setTimeout` 合并成一次 `setMessages`；`done` 到达时再 flush 一次并用服务端落库的完整 `reply` 覆盖本地拼接结果，避免跨工具轮次的换行差异。请求中禁用输入与发送，assistant 气泡为空且仍在请求时显示「思考中…」。
- **对话页用自己的 `chatApi.ts`/`artifactApi.ts`，不改 M6-01 的 `api.ts`**：两者都只走相对路径；chat 的 SSE 解析放在 `chatApi.ts`（fetch + `ReadableStream.getReader`，EventSource 不支持 POST），产物页的检索/详情也独立成文件，保持既有 API 模块不再膨胀。
- **在途对话流纳入优雅退出**：`createApp` 维护 `activeChats` 集合，每个 POST /chat 持有 AbortController；`preClose`/`onClose` 对全部在途流先 `abort()` 再 `end()`，runMainTurn 的 provider 流被中止后不再写 done，`app.close()` 不会被长对话拖住。新增 GET /messages（默认 50 条）与 GET /artifacts/:id；服务层仍只做参数整形与调用 store/agent，不写业务判断。

## M6-02 执行时间线（2026-10-26）

- **SSE 用命名事件 + `addEventListener`，不是只写 `onmessage`**：M4-02 的帧是 `event: <type>` + `data: <payload>`，浏览器不会把命名事件派发给 `onmessage`；因此对 SPEC §4.4 的 15 种类型逐个注册监听，同时保留 `onmessage` 兜底未命名帧。线上帧不含 `actor`/`ts`，增量事件按类型推导 actor、时间戳取接收时刻；首屏历史来自 `GET /tasks/:id`，字段完整。
- **`GET /tasks/:id` 只给最近 20 条，刷新后靠“历史回填流”补齐**：首次 GET 后从 `after=0` 再开一条 EventSource，按 seq 去重地把更早历史灌入同一缓冲，到达首屏最大 seq 后关闭；实时流仍按任务卡要求从 `after=<maxSeq>` 开始。这样 100+ 事件刷新页面仍完整，且不必改后端分页契约。
- **合批用 24ms `setTimeout` + Map 缓冲，每 flush 只一次 `setState`**：SSE 回调只做解析与 `enqueueEvent`；pending 达到 1000 条时同步强刷，避免后台标签页定时器停摆造成无限堆积。选定时器而不是 rAF，是因为后台标签页中 rAF 会暂停而 SSE 仍可能到达。
- **断线重连先 GET、再从“断线前游标”重开流**：GET 补任务状态与最近事件；重开 URL 用断线前记录的 SSE 游标（`resumeAfter`），而不是 GET 返回的最近最大 seq——后者在断线超过 20 条事件时会造成中间空洞。重放区间靠 seq 去重，做到不丢不重；GET 合并只改 UI，不推进游标。
- **虚拟列表用 `useVirtualizer` + `measureElement` 动态测高**：Markdown、工具预览、折叠 payload 的行高差异大，固定行高会截断；`overscan: 8` 下 100+ 事件只挂载可视行与少量缓冲行。自动跟随以“距底部 ≤48px”判定，用户上翻后新事件不再抢滚动，重新打开开关或手动回底才恢复。
- **取消/重试放在新的 `taskActions.ts`，不改 M6-01 的 `api.ts`**：详情页专属动作独立成文件，继续只用相对路径；`react-markdown` 不启用 raw HTML，避免事件 payload 里的内容变成可执行 HTML。

## M6-01 前端骨架与任务看板（2026-10-25）

- **Vite root 固定在 `src/web`，并给 `src/web` 独立 tsconfig**：根 tsconfig 的 `include` 是后端/脚本的 `src/**/*.ts`，若 web 的 `.tsx` 落进来，后端类型检查会因缺 JSX/DOM 配置而红。根 tsconfig 用 `"exclude": ["src/web", "node_modules", "dist"]` 隔离；web tsconfig 单独启用 `jsx: react-jsx`、DOM lib、Bundler 解析和 `noEmit`，`typecheck` 串行跑两份配置。Vite 配置用 `import.meta.url` 定位自身目录，避免写死本机路径；CLI 加 `--configLoader native`，由 Node 24 直接执行 TS 配置，跳过 Rolldown 再打包配置（受限 Windows 环境下那一步会触发 `spawn EPERM`，也与“Node 24 原生跑 TS”的仓库风格一致）。
- **React 固定 18.x（含 `@types/react` 18）**：任务卡要求 React 18 `createRoot`，也避开 antd 6 在 React 19 下的新行为；antd 6 的 peer 只要求 `>=18`。依赖只新增任务白名单里的 8 个包，`@types/react`/`@types/react-dom` 与运行时同主版本，避免类型漂移。
- **不引 react-router，用两个 state 做极简路由**：看板/详情只需“当前视图 + 选中任务 id”，M6-03 再评估是否值得引入路由；菜单里的「产物库/对话」保留占位，避免提前扩大依赖面。详情页先直接展示 `GET /tasks/:id` 的 JSON，M6-02 换成时间线。
- **看板用 TanStack Query 每 2 秒轮询，新建成功后主动 invalidate**：轮询满足“其他入口插入的任务 2 秒内出现”，mutation 成功后再立即失效一次，不必依赖下一次 tick。任务卡说“产物数（如接口有）”，当前 `GET /tasks` 的 Task 没有产物计数字段，因此不展示该列，也不额外拉 `/artifacts` 拼凑不准确的计数。
- **`pnpm dev` 用 `scripts/dev.ts` 而非 concurrently**：Node 24 原生 `spawn` 同时起 `node src/index.ts` 与 `pnpm dev:web`，`stdio: inherit` 不依赖管道；Ctrl-C/SIGTERM 先 `taskkill /PID <pid> /T /F` 树杀（POSIX 先 SIGTERM，2 秒后 SIGKILL），任一子进程异常退出也会收掉另一个，避免 Windows 留下 cmd/vite 孤儿。前端只走相对路径 `/tasks` 等，代理目标固定为本机 `127.0.0.1:4310`，不读也不碰 `.env`。

## M5-02 上下文组装与记忆注入（2026-10-25）

- **组装与采集分离**：`gatherMainContext` 只读库（facts / board / related / history），`buildMainContext` 纯拼接 provider 入参；`main-loop.ts` 只把原来的「系统提示 + 最近历史」两段替换为这两个调用，循环、工具分发、记账、终态收口一行未改，M5-01 的 m5 用例零改动全绿作为行为不变证明。空上下文时系统提示与 `MAIN_SYSTEM_PROMPT` 逐字相同，避免改变既有提示契约。
- **滑动窗口不做 LLM 摘要（已定偏差）**：超出 12 轮的旧对话只折成一行 `[已省略 N 轮更早对话]`，不额外调用模型。理由是多一次调用换来的摘要收益不抵成本；将来需要时可在 `gatherHistory` 内替换为摘要，属可逆决策。`N` 按 user+assistant 两条一轮计算（15 轮 → 省略 3 轮）。
- **看板超过 30 个活动任务改为状态汇总**：活动任务 = 非 completed / cancelled（failed 仍可重试，按活动处理）。≤30 时每任务一行 `[id] title | status | 产物 N`，产物数用一条按 task_id 分组的 COUNT 查询；>30 时只输出一行 `[看板汇总] 活动任务 N 个 | queued x | running y …`，不展开 id/title。阈值取 30 是为了在“看板一眼可读”和“不把任务表塞进上下文”之间折中，后续可配置化。
- **related 的 query 就是最近一条用户消息的前 50 个字符**（按 Unicode 码点截断后 trim），直接交给既有 `searchArtifacts(..., limit=5)`。命中结果只映射 `title` / `summary` / `tags`：path、sha256、findings 与正文全部在 `gatherRelated` 丢弃，正文只能经显式 `read_artifact` 进入上下文。既有 FTS 对中文按 trigram 匹配，因此 query 与摘要需要共享至少 3 字的连续片段；这是检索层现状，不在本卡扩大范围。
- **子智能体上下文只导出不强接线**：`buildAgentContext` 复用 `prompt.ts` 的 goal/工作区/权限卡，再追加父任务最近 3 条产物 summary；`gatherAgentContext` 在无 parent 或 parent 不存在时返回空。`loop.ts` 本卡未改，接入留给 M6+。

## M5-01 主线 AI 循环与工具集（2026-10-25）

- **`runtime/ops.ts` 是纯行为等价抽取，不是重写**：把 POST /tasks、cancel、retry 的「insert/事件/表/abort」顺序原样搬进 `createTask` / `cancelTask` / `retryTask`，server 只保留 HTTP 参数整形与响应；取消 reason 的校验也放在 ops 的任务/状态检查之后，保持 M4-02 的 404→409→400 判定顺序。事件顺序、错误码、409 文案、scheduler.cancel 时机全部照 M4-02；m4.test.ts 一字未改全绿即行为不变证明，另加三条 `app.inject` 冒烟（POST /tasks、cancel、retry）锁住路由。
- **主线工具与执行内核彻底分线**：`main-tools.ts` 只查任务/产物/事实仓储、调 ops 和写 `memory.fact_upserted`，不 import 任何文件或子进程模块；需要动手时只能 `create_task`。`create_task`/`retry_task` 成功后同步调用注入的 `onTaskCreated`（异步返回值的失败只记日志），装配层用它接 `scheduler.tick`，主线回复不等待任务执行完。
- **`ask_user` 是主线控制流，不是子智能体的 waiting_input**：工具执行结果直接作为本轮回复（`需要向用户澄清：…`），main-loop 立即结束、不再多叫一次模型；trace 里记 `decision='ask_user_direct_reply'`，任务表不发生任何变化。
- **工具轮上限按「已执行的工具轮」计数，收口不抛错**：每轮先调 provider，若返回 tool_calls 且已执行满 `maxToolRounds`，保留本次文本、丢弃未执行调用，返回 `[已达工具轮上限]` 说明；执行满最后一轮后不再发下一次 provider 调用，因此“无限工具剧本”不会因为多探一次而耗尽脚本。`maxToolRounds=0` 仍允许一次纯文本调用。
- **记账与历史**：每次 provider 调用逐条写 `llm_calls`（purpose='main'、usage 真值、失败也记 0）并追加全局 `llm.call` 事件；messages 只落 user/assistant，`task_id=NULL`、seq 按主线会话递增，content 按 SPEC 存 JSON 字符串。historyLimit 默认 12 轮（取最近 24 条消息，含本轮 user），M5-02 再替换为带摘要的滑动窗口。
- **长期事实的取代是事务性的**：同 scope+key 当前有效记录值不同时，同一事务内插入新记录并把旧记录 `superseded_by` 指向新记录，新记录 confidence 默认 0.6；同值重复 remember 只更新来源/时间，不制造重复行。`recallFacts` 只读 `superseded_by IS NULL`，按 confidence DESC、updated_at DESC 排序，query 对 key/value 做子串匹配。`read_artifact` 在 M7-01 落正文前对已有产物返回空正文，但 offset/limit 默认 2000 的分页元数据已就位。

## M4-02 REST + SSE（2026-10-24）

- **直接依赖只新增 `fastify`，日志用 `console` 结构化 JSON 而不是 pino**：服务层是薄层，只做参数校验、调 store/runtime、JSON 编解码；Fastify 自带类型，因此不装 `@types/fastify`。pino 只作为 Fastify 的传递依赖存在，没有进入 `dependencies`，也没有自定义日志器。
- **SSE 实时源选 `events` 表轮询（默认 150ms）+ 15s 心跳，不引 ws**：单用户量级下轮询足够，实时性与“事件是唯一真相源”一致；断点续传只依赖全局单调 `seq`。连接建立时先按 `pageSize=500` 分页补齐 `after` 之后的历史，再进入轮询；`req close` 清理轮询/心跳定时器，Fastify `preClose` 主动 end 全部 SSE 连接，避免 `app.close()` 被长连接拖住。
- **cancel 对 queued/waiting_input 返回 409 是契约行为**：M0-02 冻结的 `TASK_TRANSITIONS` 只有 `running→cancelled`，没有 `queued→cancelled` / `waiting_input→cancelled`；路由按任务卡顺序先写 `task.cancelled{reason}`、再 `updateTaskStatus(running→cancelled)`、最后 `scheduler.cancel` abort 在跑 loop。若该任务不是当前在跑任务，`cancel()` 返回 false，路由只走纯表路径。注意：loop 的中断收尾按 agent 层既有行为仍会写一条 `task.failed{interrupted}`，服务层与调度器都不再重复写终态事件；事件流里“取消后紧跟一条 interrupted 失败”是当前 agent/调度器边界，若要改变须 [contract] 提交。
- **`scheduler.ts` 严格只追加**：新增 `cancel(taskId)` 与 `currentTaskId` 跟踪，只在 loop 正常返回后的收尾处加“任务表已 cancelled 时 `finishRun(cancelled)` 并直接返回”的终态防御；`tick/runAll/shutdown`、派任务顺序、租约续约、waiting_input 收尾等既有路径一行未改。
- **启动端口取 4310，仅监听 127.0.0.1**：SPEC 未指定端口，取不常见的 4310 减少与本机其他服务冲突，可用 `PORT` 覆盖；默认工作区 `<repo>/workspace`、数据目录 `<repo>/data`，分别用 `WORKSPACE_DIR` / `DATA_DIR` / `DB_PATH` 覆盖。`.env` 手写解析、进程环境优先，任何日志/错误都不回显 key 值。

## M4-02 修订 · loop 终态守卫（2026-10-24）

- **取消路径的问题在“事件流写侧”，不是 fold 过严**：取消路由先写 `task.cancelled`、改任务表、再 abort；loop 恢复后在 catch 里仍补 `llm.call`（零 usage）与 `task.failed`，`foldEvents` 在 cancelled 之后拒绝活动事件，整条事件流作废。修法是在 `loop.ts` 每次写事件前查任务表终态（completed / cancelled），而不是放宽 `foldEvents`——脏数据必须继续暴露，只是正常路径不再生产它。
- **三处守卫 + 一处顺手**：`agent.step` 前（已终态直接返回 `interrupted` 结局，不写事件）；`appendLlmCall` 内（正常响应与 catch 分支的零 usage 记账两条路径都跳过）；`fail()` 内（终态不写 `task.failed`，reason 原样返回）；`agent.message` 同模式跳过。守卫紧贴 append，`isTaskClosed` 读取与写入之间没有 `await`：单线程事件循环下取消路由只能在 loop 的 `await` 处插入，因此不存在“检查后被取消”的竞态。
- **与调度器终态防御配合**：loop 返回 `failed{interrupted}` 但不写事件；`executeTask` 发现任务表已 cancelled 时只 `finishRun(cancelled)`，不覆盖任务表、不再写事件。最终任务表 / run / 事件流三者都停在 cancelled。
- **上一节关于“取消后仍写一条 task.failed”的边界说明作废**：本节取代该说明；取消现在以 `task.cancelled` 收尾、可被 `foldEvents` 折出 cancelled，`m4.test.ts` 的“取消后事件流仍可折叠”回归用例锁住该序列。
- **工具执行中取消的残留边界已修（同一轮追加）**：`executeTool.ts` 现在也持有同款 `isTaskClosed(db, taskId)`，`appendToolCall` / `appendToolResult` 写入前先查任务表终态（completed / cancelled），已终态则整条跳过事件写入，执行、中止与返回结构完全不变（`taskId` 为 null 时视为未关闭，行为不变）。取消落在长工具调用（如 `run_command`）时，abort 杀树后不再补 `agent.tool_result`，事件流稳定以 `task.cancelled` 收尾；`m4.test.ts` 的“工具执行中取消”回归用例锁住该序列（`tool_result` 缺失是预期，输出中注明），并验证命令进程确实已被杀。检查与 append 之间无 `await` 的不变量与 loop 侧一致。

## M4-01 调度器与恢复（2026-10-24）

- **并发 1 用“busy 标志 + 当前执行 promise”而不是锁**：`tick()` 在第一次 `await` 之前同步置 busy，并发调用只会拿到 `{started:false, reason:'busy'}`；`shutdown()` 等待同一个 promise，单进程模型下无需队列锁/工作线程。
- **派任务严格“insertRun → task.started 事件 → 表 queued→running”**：事件是唯一真相源，表是投影；loop 仍只负责写 `task.completed` / `task.failed` / `ask_user` 等事件，调度器只按 `LoopOutcome` 推进表并收 run，避免两处写同一终态事件。`run.attempt` 取该任务既有 runs 数 + 1，重试永远是新 run。
- **waiting_input 的 run 收 `interrupted`**：一次执行在 ask_user 处已经结束，run 不能保持 running 等用户；任务表进 waiting_input 保留待回复语义。用户回复后的恢复由 `waiting_input→running` + 新 run 表达（后续卡），不在 waiting_input 状态续租。
- **shutdown(abort) 与外部 signal 都走 loop 的 interrupted 失败路径**：loop 先补 `task.failed{reason:'interrupted'}`，调度器再把 run 收 `interrupted`、任务表 running→failed；调度器不会替 loop 重写终态事件。正常结束的租约定时器在 `finally` 里 `clearInterval`，续约回调发现 run 已收尾也会自清。
- **reaper 对过期 run 先收 run，再按任务状态分流**：任务仍 running 时补 `task.failed{reason:'interrupted', attempt}`；`attempt < 3` 追加 `task.queued` 并走 `running→failed→queued`（foldEvents 由此把 attempt 递增），用尽则只到 failed。任务已 completed/cancelled 的孤儿 run 只把 run 收 interrupted，不发任务事件、不改任务表；启动恢复默认在 `createScheduler` 内先跑一次 reaper，但恢复动作本身始终可通过 `reapExpiredRuns` 单独调用与验收。

## M3-04 看门狗与预算（2026-10-24）

- **`llm_calls` 按“一次 run 一条汇总行”记账，而不是逐次 LLM 调用**：M3-03 的 loop 已经在事件流里逐步写了 `llm.call`（含每次调用的 in/cached/out/ms），表里再逐调用写一份会形成两份容易漂移的账；而 `LoopOutcome` 只返回本次运行的累计 usage，逐调用记账必须改 `loop.ts`（本卡禁止）。汇总行以 `purpose='agent'`、`latency_ms=elapsedMs` 落库，日预算按 `input+output` 聚合；`insertLlmCall` 仍保留 `estimated` 入参并原样落 0/1，供后续主线（M5-01）逐调用记账使用。局限：loop 的聚合 usage 不暴露 `estimated`，所以汇总行固定记 0。
- **`budget.warning` 写成不挂 `task_id` 的全局事件**：告警发生在 loop 返回之后，此时该任务已写入 `task.completed` / `task.failed`；若把告警挂到该任务，`foldEvents` 会因“终态后出现活动事件”抛 `E_INVALID_TRANSITION`。全局事件既保留在总事件流中供 UI 展示，也不污染单任务折叠。
- **80% 告警的“恰好一次”靠“当日同类型事件存在性查询 + 同步追加”**：写完 `llm_calls` 后按本地日历日查 `events` 中是否已有 `budget.warning`，没有才追加；查询、判断、插入都在同一个同步块内完成（中间无 `await`），单进程单写者下并发 run 也不会重复发。告警阈值判断包含 100% 以上（跨过 80% 就发），100% 本身只由 gate 拦截新任务。
- **日边界用本地日历日 `[00:00, 次日 00:00)`，而不是固定 24 小时**：`getLocalDayRange` 用 `Date` 构造器计算，兼容夏令时；`getDailyUsage` 的 SQL 用 `ts >= start AND ts < end` 半开区间，避免边界记录被相邻两天重复统计。
- **gate 与执行解耦**：`canStartTask(db, now, budget)` 只读地返回 `{allowed, spent, budget}`，供 M4 调度器派新任务前调用；`runGuardedLoop` 自己不调用 gate，因此已通过 gate 的在跑任务不会因日预算中途到 100% 被打断。任务级预算则通过 `limits.maxTokens = task.budgetTokens` 接线，仍复用 loop 既有的 `failed{max_tokens}` 终态。LLM 调用 ID 用 `l_<ulid>`，与 `t_` / `r_` 同族。

## M3-03 agent loop + 假 provider（2026-10-24）

- **`submit_result` 与 `ask_user` 都作为控制流工具处理，不经 `executeTool`**：前者无任何副作用，只是一次结构校验与循环出口；后者在 `foldEvents` 里靠 `agent.tool_call{tool:'ask_user'}` 进入 `waiting_input`，而 `executeTool` 会强制紧跟一条 `agent.tool_result`，折到 `waiting_input` 后会被状态机拒绝（活动事件只允许 running）。因此 loop 只给 `ask_user` 写 `tool_call`、不写 `tool_result`，给 `submit_result` 手写成对的事件；真正的文件/命令副作用仍只走 `executeTool`。
- **`loop` 自己写终态事件，但不改 `tasks.status` 行**：`task.completed{result_json}` / `task.failed{reason,attempt,error_code?}` 由 loop 在返回前补齐，事件流是唯一真相源、可直接被 `foldEvents` 折出终态；任务表与 run 表的状态推进仍留给 M4 调度器（本卡没有 run 生命周期，提前写行会用错 queued→completed 的转移）。`task.created` / `task.started` 由调用方（或测试夹具）先写入。
- **只聊不提交的失败语义取 `max_steps`**：模型可以连续多轮不调工具，循环仍按步计费；步数耗尽时“没有通过校验的结果”自然由步数上限先触发，比事后补判 `result_invalid` 更贴近实际发生的事。token/墙钟同理各自返回 `max_tokens` / `wall_clock`。
- **校验器硬编码约束、测试解析 schema 防漂移**：`result-validator.ts` 不读文件、不引 zod、不实现通用 JSON Schema 引擎，避免运行期依赖 cwd/打包布局；`m3.test.ts` 直接读 `schemas/result.schema.json`，逐项断言 required、kind 枚举、长度/条数上限与 `RESULT_CONSTRAINTS` 及 `SUBMIT_RESULT_SPEC` 一致，任一侧改动都会红。
- **墙钟上限用内部 AbortController 主动中止在途调用**：到点先 `abort` provider/工具，再按 `wall_clock` 收尾，避免“只在两步之间检查”导致慢流式调用拖过上限；工具被中止时仍需等 `executeTool` 写完成对事件，防止终态事件后混入活动事件。失败的 LLM 调用也记一条 `llm.call`（usage 记 0），保证每个 `agent.step` 都有调用留痕。
- **工具参数 JSON 解析失败不吞**：普通工具补一对 `agent.tool_call`/`agent.tool_result{E_INVALID_ARGUMENT}` 后回喂模型；`submit_result` 的参数解析失败按一次校验失败计入重试。工具执行失败（含 `E_TOOL_EXIT`、路径拒绝）只回喂、不终止循环，只有上限、异常、`result_invalid` 才写 `task.failed`。

## M3-02 文件与命令工具（2026-10-24）

- **read_file / run_command 的实现在 executeTool.ts 原地保留，fs.ts / shell.ts re-export 并注册**：这两个工具已有 M3-01 的路径校验、超时杀树、截断、事件成对等验收，搬移只会扩大回归面；`fs.ts` 负责 list_dir / glob / grep / write_file，`shell.ts` 负责白名单常量与 run_command 注册，六件套仍全部经 `executeTool` 分发。
- **注册表采用“首次调用时懒登记”**：`executeTool.ts` 持有 `Map<name, {spec, handler}>`，fs/shell 通过 `registerTool` 登记；`executeTool` 与两个工具模块存在 ESM 循环引用，若在模块顶层立即登记，会在直接 import `tools/fs.ts` 时读到尚未初始化的常量（TDZ）。懒登记保证模块图求值完成后再读取 spec/handler，同时保留“同名先登记者优先”，便于测试或后续配置替换。
- **命令白名单叠加在既有硬拒绝之前**：argv[0] 经 `commandStem` 归一化后必须命中 `DEFAULT_ALLOWED_COMMANDS`（node/npm/npx/pnpm/yarn/git/python/python3/py/pip/cmd/powershell/pwsh/where/tar/robocopy）；注入 `allowedCommands` 可替换清单，空数组即全部拒绝。`cmd`/`powershell`/`pwsh` 放进默认清单的理由是内层硬拒绝（format/diskpart/reg delete/EncodedCommand 等）、shell 串分词与管道拒绝、删除族路径校验仍然执行，白名单只是第一道闸，不是 OS 沙箱。
- **绝对路径命令不存在时仍交给 spawn 报 ENOENT/E_NOT_FOUND**：M3-01 已有“缺失命令返回 E_NOT_FOUND”的断言，而白名单只约束可执行命令；不存在的绝对路径不可能产生副作用，因此放行到 spawn 以保持既有错误语义，裸命令名不在清单内仍直接 E_COMMAND_DENIED。
- **glob 只返回文件、list_dir 返回目录项**：目录已由 list_dir 负责，glob 面向“可读取的文件路径”，避免 `src/*` 把子目录混进文件列表；`*`/`?` 不跨 `/`，`**/` 可匹配零层目录，结果按相对路径排序、默认上限 200。遍历用 `fs.readdir` 递归并跳过符号链接，所有条目仍逐个经 `resolveWorkspacePath` 校验。
- **grep 只读 2MB 以内的文件并按行匹配**：超过 2MB 的文件跳过并计数，在输出末尾注明 `skipped N file(s) larger than 2MB`；命中默认上限 200，超出时截断并追加标记。正则非法时返回结构化 `E_INVALID_ARGUMENT`（与 read_file 非法 offset 的处理一致），不抛出未捕获异常；非法正则原文不回显。
- **write_file 写前算 sha256，结果与 `agent.tool_result` 事件都带 `sha256`/`bytes`**：创建父目录后直接 `writeFileSync`，因此覆盖是“截断后重写”而非原子替换；返回值给模型的是相对路径 + 字节数 + sha256，事件 payload 同步记录，便于后续产物校验。路径仍只走 `resolveWorkspacePath(..., 'write')`，read-only 与工作区逃逸分别返回 E_COMMAND_DENIED / E_WORKSPACE_ESCAPE。

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

## 契约 · result.schema.json（2026-10-24，随 M3-03 前置起草）

- **字段只取 SPEC 明确要求的三个**：`summary` / `findings` / `artifacts`（附录 B 子智能体提示规则 2），不发明 status/success 之类字段——"做不到"按附录 B 规则 3 用 summary 表达；真正的失败（异常/超时）走 task.failed 路径，二者不混。
- **长度上限是防滥用约束**：summary≤4000、findings≤50 条、artifacts≤20 项（kind/title/summary 必填，path 仅 note 可省，tags≤10）。数值为工程默认，无 SPEC 依据，调整需 [contract] 提交。
- **artifacts.kind 与 tasks 表 §4.2 的四值一致**（file|note|dataset|patch）；path 为工作区相对路径，M7-01 落盘与 sha256 以它为准。
- **校验实现**：M3-03 用针对本 schema 的专用结构校验器（约百行），不引入 zod、不实现通用 JSON Schema 引擎——契约层保持零依赖哲学（与 node:sqlite/自研 ULID 同一决策线）。

## 契约 · §5.6 白名单补 Vite（2026-10-24，随 M6-01 前置修订）

- M6-01 任务卡指定 "Vite + React + AntD"，但 §5.6 白名单表漏列 Vite——属 SPEC 内部不一致，按契约流程修订补入（vite、@vitejs/plugin-react、@types/react、@types/react-dom），并注明仅限 src/web/ 前端构建；后端仍零打包器。

## M7-01 补记（Manager 接线，2026-10-24）

- DSH 交付本卡时 scheduler.ts 属禁改文件，onBeforeComplete 钩子只在测试直连路径生效；Manager 在验收时补上调度器接线（executeTask 的 runGuardedLoop 增加 onBeforeComplete → persistArtifacts，生产路径用默认 data/artifacts 目录），并追加回归测试「调度路径真实落盘 2 件产物 + 事件顺序」锁定。

## 契约 · v1.1 多模态与图标包（2026-10-24）

- 实测（api-notes 之外）：DeepSeek `/chat/completions` 接受 OpenAI 多模态 content 数组，64x64 纯红 PNG 被正确识别为"红色"（HTTP 200，in≈199 token）。据此 `LlmMessage.content` 扩展为 `string | readonly LlmContentPart[]`，向后兼容（原字符串路径不变）；新增 `llmContentText()` 提取纯文本。
- `@ant-design/icons` 补入白名单：antd v5 的官方图标伴侣包（antd 自身依赖它，pnpm 严格模式下显式声明才可 import），MIT 纯 JS。
- 历史轮图片折占位的成本策略：仅当前轮携带真实图片分片。
