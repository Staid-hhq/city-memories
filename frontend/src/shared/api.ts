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
  return '暂时连接不上服务，请确认服务和连接状态后重试。'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseError(status: number, result: unknown, retryAfter: string | null, fallbackCode = 'REQUEST_FAILED') {
  const detail = isRecord(result) && isRecord(result.error) ? result.error : null
  const code = typeof detail?.code === 'string' && detail.code.trim() ? detail.code : fallbackCode
  const fallback = status >= 500 ? '服务暂时无法处理请求，请稍后重试。'
    : status === 401 ? '登录状态已失效，请重新登录。'
    : status === 403 ? '请求未获允许，请核对当前状态后重试。'
    : '请求失败，请核对当前状态后重试。'
  const message = typeof detail?.message === 'string' && detail.message.trim() ? detail.message : fallback
  return new ApiError(status, code, message, Number(retryAfter) || null)
}

function invalidResponse(status: number) {
  return new ApiError(status, 'RESPONSE_INVALID', '服务响应无法识别，请核对当前状态后重试。')
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

export async function originalBytes(photoId: string, signal: AbortSignal, scope: 'active' | 'trash' = 'active'): Promise<Blob> {
  const requestGeneration = generation
  const controller = new AbortController()
  pending.add(controller)
  const combined = AbortSignal.any([controller.signal, signal])
  let release: (() => void) | undefined
  try {
    release = await originalPermit(combined)
    combined.throwIfAborted()
    const response = await fetch(`/api/v1/${scope === 'trash' ? 'trash/' : ''}photos/${encodeURIComponent(photoId)}/original`, {
      signal: combined, credentials: 'same-origin', cache: 'no-store',
    })
    if (requestGeneration !== generation) throw new DOMException('会话已改变', 'AbortError')
    if (!response.ok) {
      if (response.status === 401) {
        clearSessionState()
        window.dispatchEvent(new Event('city-memories:expired'))
      }
      throw new ApiError(response.status, 'ORIGINAL_UNAVAILABLE', response.status === 410 ? '保留期限已到，原图不能再查看或恢复。' : '原图暂时无法读取，请核对状态后重试。')
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
    // A stopped backend/proxy can return an empty or HTML error response. Keep
    // its HTTP status instead of turning a JSON parse failure into a network error.
    const result: unknown = response.status === 204 ? null : await response.json().catch((reason: unknown) => {
      signal.throwIfAborted()
      if (requestGeneration !== generation) throw new DOMException('会话已改变', 'AbortError')
      if (!response.ok || reason instanceof SyntaxError) return null
      throw reason
    })
    signal.throwIfAborted()
    if (requestGeneration !== generation) throw new DOMException('会话已改变', 'AbortError')
    if (!response.ok) {
      const error = responseError(response.status, result, response.headers.get('Retry-After'))
      if (response.status === 403 || error.code === 'SESSION_EXPIRED') csrfToken = null
      if (response.status === 401 && privateRequest) {
        clearSessionState()
        window.dispatchEvent(new Event('city-memories:expired'))
      }
      throw error
    }
    if (response.status !== 204 && (!isRecord(result) || !Object.hasOwn(result, 'data') || result.data === null || result.data === undefined)) {
      throw invalidResponse(response.status)
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('city-memories:data-changed'))
      const channel = new BroadcastChannel('city-memories-data')
      channel.postMessage('changed'); channel.close()
    }
    return (isRecord(result) ? result.data : null) as T
  } finally {
    pending.delete(controller)
  }
}

// XHR provides actual multipart transfer progress. 100% means bytes sent, not
// server validation or a photo commit; it shares the JSON API's session guard.
export async function uploadFile<T>(path: string, file: File, signal: AbortSignal, progress: (percent: number) => void): Promise<T> {
  const requestGeneration = generation
  const controller = new AbortController()
  pending.add(controller)
  const combined = AbortSignal.any([controller.signal, signal])
  try {
    if (!csrfToken) {
      const result = await api<{ csrf_token: string }>('/auth/csrf', { signal: combined }, false)
      csrfToken = result.csrf_token
    }
    combined.throwIfAborted()
    return await new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const abort = () => xhr.abort()
      const cleanup = () => combined.removeEventListener('abort', abort)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && !combined.aborted && requestGeneration === generation) {
          progress(Math.round(event.loaded / event.total * 100))
        }
      }
      xhr.onload = () => {
        cleanup()
        if (combined.aborted || requestGeneration !== generation) { reject(new DOMException('会话已改变', 'AbortError')); return }
        const result: unknown = xhr.response
        if (xhr.status >= 200 && xhr.status < 300) {
          if (isRecord(result) && Object.hasOwn(result, 'data') && result.data !== null && result.data !== undefined) resolve(result.data as T)
          else reject(invalidResponse(xhr.status))
          return
        }
        const error = responseError(xhr.status, result, xhr.getResponseHeader('Retry-After'), 'UPLOAD_FAILED')
        if (xhr.status === 403) csrfToken = null
        if (xhr.status === 401) { clearSessionState(); window.dispatchEvent(new Event('city-memories:expired')) }
        reject(error)
      }
      xhr.onerror = xhr.ontimeout = () => { cleanup(); reject(new TypeError('Network error')) }
      xhr.onabort = () => { cleanup(); reject(new DOMException('传输已停止', 'AbortError')) }
      xhr.open('PUT', `/api/v1${path}`)
      xhr.responseType = 'json'
      xhr.timeout = 15 * 60 * 1000
      xhr.setRequestHeader('X-CSRF-Token', csrfToken!)
      combined.addEventListener('abort', abort, { once: true })
      const body = new FormData()
      body.append('file', file)
      xhr.send(body)
    })
  } finally { pending.delete(controller) }
}
