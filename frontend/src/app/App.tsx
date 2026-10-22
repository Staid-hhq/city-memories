import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { api, ApiError, clearSessionState, errorMessage, isAbort, setCsrfToken } from '../shared/api'
import type { LoginResult, User } from '../shared/api'
import { OperationFeedback } from '../shared/OperationFeedback'
import { Journal } from '../features/albums/Journal'

type SessionState =
  | { phase: 'loading' | 'guest' | 'logging-out' | 'logout-error'; message?: string }
  | { phase: 'error'; error: unknown }
  | { phase: 'user'; user: User }

function isUser(value: unknown): value is User {
  if (!value || typeof value !== 'object') return false
  const user = value as Partial<User>
  return [user.id, user.username, user.created_at].every(field => typeof field === 'string' && field.length > 0)
}

async function readSession(controller: AbortController) {
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
  const user = await api<User>('/auth/me', { signal }, false)
  if (!isUser(user)) {
    throw new ApiError(200, 'RESPONSE_INVALID', '登录状态响应无法识别，请重新连接后再试。')
  }
  return user
}

function connectionTitle(error: unknown) {
  if (error instanceof DOMException && error.name === 'TimeoutError') return '连接等待超时'
  if (error instanceof ApiError && error.status >= 500) return '服务暂时不可用'
  if (error instanceof ApiError && error.code === 'RESPONSE_INVALID') return '服务响应无法识别'
  return '暂时无法连接城影记'
}

function connectionDescription(error: unknown) {
  return error instanceof DOMException && error.name === 'TimeoutError'
    ? '等待服务响应超过 15 秒，请确认服务已就绪后重新连接。'
    : errorMessage(error)
}

function ConnectionHelp() {
  return <details className="connection-help"><summary>查看本机启动步骤</summary>
    <ol><li>在 PyCharm 选择“城影记－启动”，确认前后端都已运行完成。</li>
      <li>如果只启动了网页，请启动“城影记－后端”；已有服务时不用重复运行。</li>
      <li>服务就绪后点击“重新连接”。仍未恢复时，查看 PyCharm 运行窗口中的报错。</li></ol>
    <p>连接提示无法确定具体原因；服务未就绪或连接中断都可能导致当前情况。</p>
    {navigator.onLine === false && <p>浏览器提示当前离线，恢复连接后可再试一次。</p>}
  </details>
}

function AuthPage({ register, onLogin }: { register: boolean; onLogin: (user: User) => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState<string>(location.state?.registeredUsername ?? '')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const notice = location.state?.registeredUsername ? '账号已创建，请使用新密码登录。' : ''
  const activeRequest = useRef<AbortController | null>(null)

  useEffect(() => () => activeRequest.current?.abort(), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      setError('用户名须为 3–32 位英文字母、数字或下划线。')
      return
    }
    if ([...password].length < 15 || [...password].length > 128) {
      setError('密码需要 15–128 个字符，可以使用空格和中文。')
      return
    }
    if (register && password !== confirmation) {
      setError('两次输入的密码不一致，请重新核对。')
      return
    }
    setBusy(true)
    const controller = new AbortController()
    activeRequest.current = controller
    try {
      if (register) {
        await api<User>('/auth/register', {
          method: 'POST', signal: controller.signal,
          body: JSON.stringify({ username, password, password_confirm: confirmation }),
        }, false)
        setPassword('')
        setConfirmation('')
        navigate('/login', { replace: true, state: { registeredUsername: username } })
      } else {
        const result = await api<LoginResult>('/auth/login', {
          method: 'POST', signal: controller.signal, body: JSON.stringify({ username, password }),
        }, false)
        if (!isUser(result?.user) || typeof result.csrf_token !== 'string' || !result.csrf_token.trim()) {
          throw new ApiError(200, 'RESPONSE_INVALID', '登录响应无法识别，请重新核对登录结果后再试。')
        }
        setPassword('')
        clearSessionState()
        setCsrfToken(result.csrf_token)
        onLogin(result.user)
      }
    } catch (reason: unknown) {
      if (!isAbort(reason)) setError(errorMessage(reason))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="journal-intro" aria-labelledby="brand-title">
        <p className="eyebrow">CITY MEMORIES · 私人旅行手帐</p>
        <h1 id="brand-title">城影记</h1>
        <p className="brand-line">走过一座城，<br />留下一本故事。</p>
        <p className="intro-copy">把旅行里的光影收好。<br />下一次想起，就从那座城市翻开。</p>
        <div className="paper-stack" aria-hidden="true">
          <div className="paper-back" />
          <div className="paper-front"><span className="paper-sun" /><span className="paper-hill" />
            <span className="paper-caption">收藏沿途的每一刻</span>
          </div>
          <span className="travel-stamp">一路<br />珍藏</span>
        </div>
        <p className="private-note">每个人的影集，只属于自己。</p>
      </section>
      <section className="auth-card" aria-labelledby="auth-title">
        <nav className="auth-tabs" aria-label="账号入口">
          <Link to="/login" aria-current={!register ? 'page' : undefined}>登录</Link>
          <Link to="/register" aria-current={register ? 'page' : undefined}>注册</Link>
        </nav>
        <p className="eyebrow">{register ? '一段新的旅程' : '好久不见，旅人'}</p>
        <h2 id="auth-title">{register ? '创建你的手帐' : '翻开你的手帐'}</h2>
        <p className="auth-description">{register ? '给自己的旅行回忆，留一个专属的位置。' : '用你的账号登录，回到自己的旅行记忆。'}</p>
        <form onSubmit={submit} aria-busy={busy}>
          <label htmlFor="username">用户名</label>
          <input id="username" name="username" autoComplete="username" required maxLength={32}
            value={username} onChange={(event) => setUsername(event.target.value)}
            aria-describedby="username-help" disabled={busy} placeholder="例如 slow_traveler" />
          <p id="username-help" className="field-help">3–32 位英文字母、数字或下划线，不区分大小写。</p>
          <label htmlFor="password">密码</label>
          <input id="password" name="password" type="password" required disabled={busy}
            autoComplete={register ? 'new-password' : 'current-password'} value={password}
            onChange={(event) => setPassword(event.target.value)} aria-describedby="password-help" />
          <p id="password-help" className="field-help">15–128 个字符，可使用空格或中文短句。</p>
          {register && <>
            <label htmlFor="password-confirm">确认密码</label>
            <input id="password-confirm" name="password_confirm" type="password" required disabled={busy}
              autoComplete="new-password" value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)} />
          </>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? '请稍候…' : register ? '创建账号' : '登录我的手帐'}<span aria-hidden="true">→</span>
          </button>
          <p className="form-footnote">{register ? '注册完成后，请使用新账号登录。' : '还没有账号？'}
            {!register && <Link to="/register"> 从第一本开始</Link>}
          </p>
        </form>
      </section>
    </main>
  )
}

export function App() {
  const navigate = useNavigate()
  const [session, setSession] = useState<SessionState>({ phase: 'loading' })
  const channel = useRef<BroadcastChannel | null>(null)
  const activeUser = useRef<string | null>(null)
  const logoutPending = useRef(false)
  const sessionRequest = useRef<AbortController | null>(null)
  const checkRequest = useRef<AbortController | null>(null)
  const [sessionNotice, setSessionNotice] = useState<unknown>()
  const [checkingSession, setCheckingSession] = useState(false)

  const loadSession = useCallback(() => {
    if (logoutPending.current) return
    sessionRequest.current?.abort(); checkRequest.current?.abort()
    const controller = new AbortController(); sessionRequest.current = controller
    activeUser.current = null; setSessionNotice(undefined); setCheckingSession(false)
    clearSessionState()
    void readSession(controller).then((user) => {
      activeUser.current = user.id
      setSession({ phase: 'user', user })
    }).catch((error: unknown) => {
      if (isAbort(error)) return
      activeUser.current = null
      setSession(error instanceof ApiError && error.status === 401
        ? { phase: 'guest' } : { phase: 'error', error })
    })
  }, [])

  const refresh = useCallback(() => {
    if (logoutPending.current) return
    setSession({ phase: 'loading' })
    loadSession()
  }, [loadSession])

  const verifySession = useCallback(async () => {
    if (logoutPending.current) return
    if (!activeUser.current) { refresh(); return }
    checkRequest.current?.abort()
    const controller = new AbortController(); checkRequest.current = controller
    setCheckingSession(true)
    try {
      const user = await readSession(controller)
      setSessionNotice(undefined)
      if (user.id === activeUser.current) return
      clearSessionState(); activeUser.current = user.id
      setSession({ phase: 'user', user })
    } catch (error) {
      if (isAbort(error)) return
      if (error instanceof ApiError && error.status === 401) {
        clearSessionState(); activeUser.current = null
        setSession({ phase: 'guest', message: '登录已过期，请重新登录。' })
      } else setSessionNotice(error)
    } finally { if (!controller.signal.aborted) setCheckingSession(false) }
  }, [refresh])

  useEffect(() => {
    loadSession()
    const bus = new BroadcastChannel('city-memories-auth')
    channel.current = bus
    bus.onmessage = refresh
    const expired = () => { logoutPending.current = false; activeUser.current = null; setSessionNotice(undefined); setCheckingSession(false); setSession({ phase: 'guest', message: '登录已过期，请重新登录。' }) }
    const restored = (event: PageTransitionEvent) => { if (event.persisted) refresh() }
    const visible = () => {
      if (document.visibilityState !== 'visible') return
      // Returning to the same account must not unmount an unsaved note or queue.
      // Broadcast logout still hides everything immediately through refresh().
      void verifySession()
    }
    window.addEventListener('city-memories:expired', expired)
    window.addEventListener('pageshow', restored)
    document.addEventListener('visibilitychange', visible)
    return () => {
      bus.close()
      sessionRequest.current?.abort(); checkRequest.current?.abort()
      clearSessionState()
      window.removeEventListener('city-memories:expired', expired)
      window.removeEventListener('pageshow', restored)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh, loadSession, verifySession])

  function loggedIn(user: User) {
    logoutPending.current = false
    activeUser.current = user.id; setSessionNotice(undefined)
    setSession({ phase: 'user', user })
    channel.current?.postMessage('changed')
    navigate('/', { replace: true })
  }

  async function logout() {
    logoutPending.current = true
    activeUser.current = null; setSessionNotice(undefined); setCheckingSession(false)
    sessionRequest.current?.abort(); checkRequest.current?.abort()
    clearSessionState()
    setSession({ phase: 'logging-out' })
    try {
      await api<void>('/auth/logout', { method: 'POST' }, false)
    } catch (error: unknown) {
      if (isAbort(error)) return
      if (!(error instanceof ApiError && error.status === 401)) {
        setSession({ phase: 'logout-error', message: '退出尚未完成。' + errorMessage(error) })
        return
      }
    }
    clearSessionState()
    logoutPending.current = false
    setSession({ phase: 'guest' })
    channel.current?.postMessage('changed')
    navigate('/login', { replace: true })
  }

  if (session.phase !== 'guest' && session.phase !== 'user') {
    return <main className="status-page"><section className="status-card connection-card">
      <p className="eyebrow">CITY MEMORIES</p><h1>城影记</h1>
      {session.phase === 'loading' || session.phase === 'error' ? <>
        <OperationFeedback tone={session.phase === 'error' ? 'error' : 'progress'} title={session.phase === 'error' ? connectionTitle(session.error) : '正在连接城影记'}>
          <p>{session.phase === 'error' ? connectionDescription(session.error) : '正在确认服务和登录状态，请稍候。'}</p>
        </OperationFeedback>
        <button className="primary-button" onClick={refresh}>重新连接</button>
        <ConnectionHelp />
      </> : <p role={session.message ? 'alert' : 'status'}>{session.message ?? '正在退出…'}</p>}
      {session.phase === 'logout-error' && <button className="primary-button" onClick={() => void logout()}>重试退出</button>}
    </section></main>
  }
  if (session.phase === 'user') {
    return <>{sessionNotice !== undefined && <div className="session-connection-notice">
      <OperationFeedback tone={checkingSession ? 'progress' : 'error'} title={checkingSession ? '正在核对登录状态' : '暂时无法核对登录状态'}
        actions={<button className="quiet-button" disabled={checkingSession} onClick={() => void verifySession()}>重新核对登录状态</button>}>
        <p>{checkingSession ? '正在重新确认登录状态，未保存内容仍在本页。' : '会话核对暂时失败，未保存内容仍在本页；请检查连接后再保存。'}</p>
        {!checkingSession && <p>{connectionDescription(sessionNotice)}</p>}
      </OperationFeedback>
    </div>}<Journal key={session.user.id} user={session.user} onLogout={() => void logout()} /></>
  }
  return <>
    {session.message && <p className="global-notice" role="status">{session.message}</p>}
    <Routes>
      <Route path="/login" element={<AuthPage key="login" register={false} onLogin={loggedIn} />} />
      <Route path="/register" element={<AuthPage key="register" register onLogin={loggedIn} />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  </>
}
