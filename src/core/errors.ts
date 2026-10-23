/**
 * 契约层 · 错误码（零依赖、零 IO）。
 * 只用可擦除语法：常量对象 + 联合类型，不用 enum。
 */

export const ERROR_CODES = {
  E_INVALID_TRANSITION: 'E_INVALID_TRANSITION',
  E_INVALID_ARGUMENT: 'E_INVALID_ARGUMENT',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_CONFLICT: 'E_CONFLICT',
  E_WORKSPACE_ESCAPE: 'E_WORKSPACE_ESCAPE',
  E_COMMAND_DENIED: 'E_COMMAND_DENIED',
  E_TOOL_TIMEOUT: 'E_TOOL_TIMEOUT',
  E_BUDGET_EXCEEDED: 'E_BUDGET_EXCEEDED',
  E_RESULT_INVALID: 'E_RESULT_INVALID',
  E_PROVIDER_AUTH: 'E_PROVIDER_AUTH',
  E_PROVIDER_QUOTA: 'E_PROVIDER_QUOTA',
  E_PROVIDER_RATE_LIMIT: 'E_PROVIDER_RATE_LIMIT',
  E_PROVIDER_HTTP: 'E_PROVIDER_HTTP',
  E_PROVIDER_TIMEOUT: 'E_PROVIDER_TIMEOUT',
  E_INTERNAL: 'E_INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 契约层异常：非法状态转移、非法参数等调用方错误。 */
export class ContractError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ContractError';
    this.code = code;
  }
}
