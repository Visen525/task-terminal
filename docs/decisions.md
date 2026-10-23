# 决策记录

每个里程碑追加 3–5 行：为什么这么做。给未来的自己（和贡献者）看。

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
