# DeepSeek API 实测记录（M2-01）

> 状态：**占位，待实测**。以下“预期”来自 `docs/SPEC.md` 附录 A，不是实测结果。
>
> 手动实测命令：`node scripts/spike-deepseek.ts`
> 前置条件：环境变量 `DEEPSEEK_API_KEY`，或仓库根目录 `.env` 中的同名变量。
> 安全：本文件与脚本输出都不得出现 API key / Authorization 头。

## 1. 非流式 `POST /chat/completions`

- 状态：待实测
- 请求要点：`model=deepseek-chat`，标准 OpenAI messages。
- 待记录：实际返回的 `choices[0].message.content`、`finish_reason`、`usage` 字段。
- 待确认：`usage.prompt_cache_hit_tokens` 是否出现、缺失时是否走估算。

## 2. 流式 `stream: true` + `stream_options.include_usage`

- 状态：待实测
- 请求要点：`stream: true`，`stream_options.include_usage: true`。
- 待记录：SSE 帧样例（可省略长文本）、`[DONE]` 行为、usage 是否在末帧、末帧 `choices` 是否为空。
- 待确认：首 token 实际耗时；分片大小与 UTF-8 跨块行为。

## 3. tool_calls

- 状态：待实测
- 请求要点：带 `tools`，`tool_choice: "auto"`。
- 待记录：`delta.tool_calls[i]` 的 index / id / function.name / function.arguments 分片方式。
- 待确认：arguments 是否严格分多帧；拼接后是否为合法 JSON；是否可能并行多个 tool_call。

## 4. `GET /user/balance`

- 状态：待实测
- 待记录：`is_available`、`balance_infos` 的实际字段与类型（字符串还是数字）。
- 待确认：余额为 0 时 `is_available` 的取值，以及是否有其它提示字段。

## 5. 错误码与超时观察

- 状态：待实测
- 待记录：400 / 401 / 402 / 429 / 500 / 503 的实际响应体结构。
- 待确认：429 是否返回 `Retry-After`；流式错误是否以 SSE 帧返回而非 HTTP 状态码。
- 待确认：连接 10s / 读取 120s / 首 token 30s 的默认值在真实网络下的表现。

## 6. 结论与后续动作

- 状态：待 Manager 实跑后填写。
- 若实测与附录 A 有出入，在此列出差异及对 `src/providers/deepseek.ts` 的影响。
