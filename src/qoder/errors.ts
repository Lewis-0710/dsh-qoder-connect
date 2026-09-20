/**
 * DSH-compatible LLM error representation.
 *
 * @module dsh-provider-qoder/qoder/errors
 */

import { LlmError, ProviderRequestId, type LlmErrorOptions } from '@deepseek-ai/dsh-llm'

export class QoderLlmError extends LlmError {
  constructor(message: string, code: string = 'UNKNOWN_ERROR', options?: LlmErrorOptions) {
    super(message, code, options)
  }
}

export function qoderHttpError(
  message: string,
  response: { status: number; headers?: Pick<Headers, 'get'> },
): QoderLlmError {
  const { status } = response
  const code = status === 401 || status === 403
    ? 'AUTH'
    : status === 408
      ? 'TIMEOUT'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500 && status <= 599
          ? 'SERVER'
          : status >= 400 && status <= 499
            ? 'INVALID_REQUEST'
            : 'PROVIDER_ERROR'
  const providerRetryAfterMs = retryAfterMs(response.headers?.get('retry-after') ?? null)
  const requestId = qoderRequestId(response.headers)
  return new QoderLlmError(message, code, {
    status,
    ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
    ...requestId === undefined ? {} : { requestId },
  })
}

export function qoderRequestId(headers?: Pick<Headers, 'get'>): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers?.get('x-request-id')
    ?? headers?.get('request-id')
    ?? headers?.get('x-amzn-requestid')
  const normalized = value?.trim()
  return normalized ? ProviderRequestId(normalized) : undefined
}

/**
 * Whether this failure is an upstream authorization rejection worth one
 * re-auth retry.
 *
 * The job token the transport signs requests with is cached in memory; an
 * upstream that invalidates it mid-lifetime (gateway rotation or a fault
 * window) answers HTTP 401/403 before any payload is produced. That state is
 * distinguishable from a genuinely revoked PAT only by trying a fresh
 * exchange, so callers clear their credential cache and retry once before
 * reporting `AUTH` to the user.
 */
export function isQoderAuthRejection(error: unknown): error is LlmError {
  return error instanceof LlmError
    && (error.code === 'AUTH' || error.failure.status === 401 || error.failure.status === 403)
}

export function retryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1000
    return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined
  }
  const retryAt = Date.parse(normalized)
  if (Number.isNaN(retryAt)) return undefined
  const delayMs = retryAt - nowMs
  return delayMs > 0 ? delayMs : undefined
}
