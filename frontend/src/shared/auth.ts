import { api, ApiError } from './api'
import type { User } from './api'

export const AUTH_WAIT_MS = 15_000

export function isUser(value: unknown): value is User {
  if (!value || typeof value !== 'object') return false
  const user = value as Partial<User>
  return [user.id, user.username, user.created_at].every(field => typeof field === 'string' && field.length > 0)
}

// Bound the whole operation, including CSRF preparation and response bodies.
// Racing cancellation also bounds bodies that stop producing data; late API
// results still face the signal/generation checks in api.ts.
export async function withAuthDeadline<T>(outer: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([outer, deadline.signal])
  const timer = window.setTimeout(() => deadline.abort(new DOMException('认证操作等待超过 15 秒', 'TimeoutError')), AUTH_WAIT_MS)
  let onAbort: () => void = () => {}
  try {
    signal.throwIfAborted()
    const canceled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([task(signal), canceled])
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export function authResultUnknown(error: unknown) {
  return !(error instanceof ApiError) || error.status >= 500 || error.status < 400 || error.code === 'RESPONSE_INVALID'
}

export function authErrorMessage(error: unknown, fallback: (error: unknown) => string) {
  return error instanceof DOMException && error.name === 'TimeoutError'
    ? '等待服务响应超过 15 秒，尚不能确认本次操作结果。'
    : fallback(error)
}

// CSRF is read before identity: if another tab changes the cookie between
// these reads, either identity detects it or the token fails safely on write.
// A 401 describes the current browser session, not the earlier write receipt.
export async function readAuthState(signal: AbortSignal): Promise<{ user: User | null; csrfToken: string }> {
  const csrf = await api<{ csrf_token: string }>('/auth/csrf', { signal }, false)
  if (!csrf || typeof csrf.csrf_token !== 'string' || !csrf.csrf_token.trim()) {
    throw new ApiError(200, 'RESPONSE_INVALID', '登录状态响应无法识别，请重新核对。')
  }
  try {
    const user = await api<User>('/auth/me', { signal }, false)
    if (!isUser(user)) throw new ApiError(200, 'RESPONSE_INVALID', '登录状态响应无法识别，请重新核对。')
    return { user, csrfToken: csrf.csrf_token }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { user: null, csrfToken: csrf.csrf_token }
    throw error
  }
}
