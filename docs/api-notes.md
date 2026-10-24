# DeepSeek API 实测记录（M2-01）

> 状态：**已实测**（2026-10-24，`node scripts/spike-deepseek.ts`，deepseek-chat，华北直连）。
>
> 手动实测命令：`node scripts/spike-deepseek.ts`
> 前置条件：环境变量 `DEEPSEEK_API_KEY`，或仓库根目录 `.env` 中的同名变量。
> 安全：本文件与脚本输出都不得出现 API key / Authorization 头。

## 1. 非流式 `POST /chat/completions` ✅

- 实测返回结构与附录 A / OpenAI 格式一致：`choices[0].message.content` 正常，`finish_reason: "stop"`。
- usage 实测：`input=9, cached=0, output=24`（短提示）。**usage 真实返回，无需走估算路径**。
- `prompt_cache_hit_tokens` 存在且为 0（短对话无缓存命中；长上下文重复前缀时预期 >0，待后续真实任务观察）。

## 2. 流式 `stream: true` + `stream_options.include_usage` ✅

- 流式正常：`delta.content` 分片推送，拼接文本与最终 content 完全一致；`[DONE]` 正常结束。
- usage 在**末帧**返回（`input=12, output=26`），末帧 choices 为空——与附录 A 预期一致，适配器按"任何帧出现 usage 都记录、以最后为准"处理正确。
- 中文 UTF-8 跨块分片在本机实测无乱码（TextDecoder stream 模式拼接正确）。
- 首 token 延迟本次未精确计时（体感 < 2s）；后续可在 `llm_calls.latency_ms` 里持续观察。

## 3. tool_calls ✅

- 实测 `finish_reason: "tool_calls"`；`delta.tool_calls[0]` 携带 `id`（`call_00_…`）与 `function.name`，`function.arguments` 分片推送。
- **arguments 拼接后为合法 JSON**（实测 `{"city": "北京"}`），`JSON.parse` 成功——验证了"收完再 parse"的实现路径。
- 本轮为单 tool_call；并行多 tool_call（同帧多个 index）适配器已按 index 累积实现，待真实任务中自然覆盖。

## 4. `GET /user/balance` ✅

- 实测字段：`is_available: true`；`balance_infos: [{ currency: "CNY", total_balance: "40.87", granted_balance: "0.00", topped_up_balance: "40.87" }]`。
- **金额是字符串不是数字**——适配器按字符串透传是正确选择，比较时用 `Number()` 转换（当前实现如此）。
- 余额为 0 时的行为未实测（不忍心烧光测试额度）；按附录 A 处理：`is_available !== true` 或全部余额 ≤ 0 → `E_PROVIDER_QUOTA`。

## 5. 错误码与超时观察 ⚠️ 部分待观察

- 400/401/402/429/500/503 的响应体结构未逐一实测（附录 A 与 mock 测试已覆盖处理逻辑）。
- 429 是否带 `Retry-After` 未实测；适配器已做"有则尊重、无则指数退避"的双路径。
- 流式错误是否走 SSE 帧而非 HTTP 状态码：未实测；适配器两条路都处理（HTTP 状态在请求层、SSE 帧内 `error` 对象在流解析层）。

## 6. 结论与后续动作

- **四项主路径全部通过，M2-01 适配器与真实 API 行为一致，无需改代码。**
- 唯一修正记录：金额字段为字符串（§4），当前实现已兼容。
- 后续观察项（不阻塞）：缓存命中 token 的真实出现场景、并行 tool_calls、429 的 Retry-After 行为——在 M4/M5 联调时顺带记录。
