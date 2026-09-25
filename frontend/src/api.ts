export type User = { id: string; username: string; created_at: string }
export type LoginResult = { user: User; csrf_token: string }

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter: number | null = null,
  ) {
    super(message)
  }
}

let csrfToken: string | null = null
let generation = 0
const pending = new Set<AbortController>()

export function clearSessionState() {
  generation += 1
  csrfToken = null
  for (const controller of pending) controller.abort()
  pending.clear()
}

export function setCsrfToken(value: string) {
  csrfToken = value
}

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.retryAfter
      ? `${error.message}（约 ${error.retryAfter} 秒后可重试）`
      : error.message
  }
  return '暂时连接不上服务，请检查网络后重试。'
}

// Original bytes share logout cancellation/generation protection with JSON.
// At most two transfers run; queued off-screen images can be canceled before fetching.
let originalTransfers = 0
const originalQueue: (() => void)[] = []
function originalPermit(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = originalQueue.indexOf(start)
      if (index >= 0) originalQueue.splice(index, 1)
      reject(new DOMException('读取已取消', 'AbortError'))
    }
    const start = () => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) { abort(); return }
      originalTransfers += 1
      resolve(() => { originalTransfers -= 1; originalQueue.shift()?.() })
    }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    if (originalTransfers < 2) start()
    else originalQueue.push(start)
  })
}

export async function originalBytes(photoId: string, signal: AbortSignal): Promise<Blob> {
  const requestGeneration = generation
  const controller = new AbortController()
  pending.add(controller)
  const combined = AbortSignal.any([controller.signal, signal])
  let release: (() => void) | undefined
  try {
    release = await originalPermit(combined)
    combined.throwIfAborted()
    const response = await fetch(`/api/v1/photos/${encodeURIComponent(photoId)}/original`, {
      signal: combined, credentials: 'same-origin', cache: 'no-store',
    })
    if (requestGeneration !== generation) throw new DOMException('会话已改变', 'AbortError')
    if (!response.ok) {
      if (response.status === 401) {
        clearSessionState()
        window.dispatchEvent(new Event('city-memories:expired'))
      }
      throw new ApiError(response.status, 'ORIGINAL_UNAVAILABLE', '原图暂时无法读取，请重试；影集记录仍然保留。')
    }
    const blob = await response.blob()
    combined.throwIfAborted()
    if (requestGeneration !== generation) throw new DOMException('会话已改变', 'AbortError')
    return blob
  } finally { release?.(); pending.delete(controller) }
}

export async function api<T>(path: string, init: RequestInit = {}, privateRequest = true): Promise<T> {
  const requestGeneration = generation
  const controller = new AbortController()
  pending.add(controller)
  const signal = init.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal
  try {
    const headers = new Headers(init.headers)
    const method = (init.method ?? 'GET').toUpperCase()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!csrfToken) {
        const token = await api<{ csrf_token: string }>('/auth/csrf', { signal }, false)
        csrfToken = token.csrf_token
      }
      headers.set('X-CSRF-Token', csrfToken)
    }
    if (typeof init.body === 'string') headers.set('Content-Type', 'application/json')
    signal.throwIfAborted()
    const response = await fetch(`/api/v1${path}`, {
      ...init, method, headers, signal, credentials: 'same-origin', cache: 'no-store',
    })
    const result = response.status === 204 ? null : await response.json()
    if (requestGeneration !== generation) throw new DOMException('会话已改变', 'AbortError')
    if (!response.ok) {
      const error = new ApiError(
        response.status, result?.error?.code ?? 'REQUEST_FAILED',
        result?.error?.message ?? '请求失败，请稍后重试',
        Number(response.headers.get('Retry-After')) || null,
      )
      if (response.status === 403 || error.code === 'SESSION_EXPIRED') csrfToken = null
      if (response.status === 401 && privateRequest) {
        clearSessionState()
        window.dispatchEvent(new Event('city-memories:expired'))
      }
      throw error
    }
    return result?.data as T
  } finally {
    pending.delete(controller)
  }
}
