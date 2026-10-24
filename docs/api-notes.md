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

## 7. 官方联网工具 `POST /v1/tools/search` / `POST /v1/tools/fetch`（M11-01）

> 状态：**Manager 已实测可用**（2026-10-24，华北直连；本卡验收用 127.0.0.1 mock server 复验，不打真 API）。
> 安全：示例中的 key 一律用 `$DEEPSEEK_API_KEY` 占位；任何日志/错误/事件都不得出现真实 key 或 Authorization 头。

### 7.1 搜索 `POST /v1/tools/search` ✅

请求：

```bash
curl -sS https://api.deepseek.com/v1/tools/search \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"DeepSeek 官方联网工具","count":8,"need_content":false}'
```

字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string | 必填，1-128 字符 |
| `count` | number | 1-50，默认 10；本客户端再钳到 **1-20**（成本护栏） |
| `ori_question` | string? | 可选，原始问题（本卡未使用） |
| `need_content` | boolean | 默认 false；false 时返回的 `content` 恒为空 |

响应：

```json
{
  "results": [
    {
      "rerank_score": 0.97,
      "title": "标题",
      "url": "https://example.com/",
      "snippet": "摘要片段",
      "summary": "600-800 字、为模型阅读设计的摘要",
      "content": "",
      "site_name": "站点名",
      "date": "2026-10-24",
      "authority": "official"
    }
  ]
}
```

- `summary` 按 600-800 字为模型阅读设计，**优先读 summary，不要默认拉正文**。
- `need_content=true` 时 `content` 才有值；本卡每条正文最多回给模型 20KB，超长截断。
- `results` 为空数组是合法响应（不计费）。

### 7.2 读原文 `POST /v1/tools/fetch` ✅

请求：

```bash
curl -sS https://api.deepseek.com/v1/tools/fetch \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://api-docs.deepseek.com/"}'
```

字段/响应：

- `url`：必填，http/https，最长 8192 字符，**禁止 userinfo**（`https://user:pass@host/` 会被拒）。
- 返回 `{ "title": "...", "content": "..." }`；正文交给工具输出上限（默认 200KB）截断。

### 7.3 计费、限速与错误映射

- **计费：5 元/千次成功请求；失败请求、无结果请求不计费。**
- 限速：search 100 QPS、fetch 25 QPS；超限返回 429。
- 本卡客户端（`src/providers/web-tools.ts`）的映射：
  - 401 → `E_PROVIDER_AUTH`
  - 429 → `E_PROVIDER_RATE_LIMIT`
  - 4xx/5xx → `E_PROVIDER_HTTP`（错误体截断到 300 字符并脱敏）
  - 20s 超时 → `E_PROVIDER_TIMEOUT`；调用方 AbortSignal → `AbortError`
  - 参数错误（query 长度、count 类型、url 协议/host/长度/userinfo）→ `E_INVALID_ARGUMENT`，不发网络
- 错误消息会移除 apiKey 与 Bearer 值；`apiKey` 只经 `ctx.webTools` 注入，不落事件/日志。

### 7.4 子代理使用护栏

- `web_search` 默认 `count=8`，最多 20；`need_content` 默认 false。
- `web_search` / `web_fetch` 每个 run 共享 **30 次**联网调用上限；第 31 次返回结构化 `E_BUDGET_EXCEEDED` 并提示改用已有结果。
- 提示词要求：优先 summary、引用来源 URL、规划好检索词。

