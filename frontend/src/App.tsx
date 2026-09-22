import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { api, ApiError, clearSessionState, errorMessage, isAbort, setCsrfToken } from './api'
import type { LoginResult, User } from './api'

type SessionState =
  | { phase: 'loading' | 'guest' | 'error' | 'logging-out' | 'logout-error'; message?: string }
  | { phase: 'user'; user: User }

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

  const loadSession = useCallback(() => {
    clearSessionState()
    void api<User>('/auth/me', {}, false).then((user) => {
      setSession({ phase: 'user', user })
    }).catch((error: unknown) => {
      if (isAbort(error)) return
      setSession(error instanceof ApiError && error.status === 401
        ? { phase: 'guest' } : { phase: 'error', message: errorMessage(error) })
    })
  }, [])

  const refresh = useCallback(() => {
    setSession({ phase: 'loading' })
    loadSession()
  }, [loadSession])

  useEffect(() => {
    loadSession()
    const bus = new BroadcastChannel('city-memories-auth')
    channel.current = bus
    bus.onmessage = refresh
    const expired = () => setSession({ phase: 'guest', message: '登录已过期，请重新登录。' })
    const restored = (event: PageTransitionEvent) => { if (event.persisted) refresh() }
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('city-memories:expired', expired)
    window.addEventListener('pageshow', restored)
    document.addEventListener('visibilitychange', visible)
    return () => {
      bus.close()
      clearSessionState()
      window.removeEventListener('city-memories:expired', expired)
      window.removeEventListener('pageshow', restored)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh, loadSession])

  function loggedIn(user: User) {
    setSession({ phase: 'user', user })
    channel.current?.postMessage('changed')
    navigate('/', { replace: true })
  }

  async function logout() {
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
    setSession({ phase: 'guest' })
    channel.current?.postMessage('changed')
    navigate('/login', { replace: true })
  }

  if (session.phase !== 'guest' && session.phase !== 'user') {
    return <main className="status-page"><section className="status-card">
      <p className="eyebrow">CITY MEMORIES</p><h1>城影记</h1>
      <p role={session.message ? 'alert' : 'status'}>{session.message ?? (
        session.phase === 'logging-out' ? '正在退出…' : '正在打开你的手帐…'
      )}</p>
      {session.phase === 'error' && <button className="primary-button" onClick={refresh}>重新连接</button>}
      {session.phase === 'logout-error' && <button className="primary-button" onClick={() => void logout()}>重试退出</button>}
    </section></main>
  }
  if (session.phase === 'user') {
    return <Routes><Route path="/" element={
      <div className="home-page" key={session.user.id}>
        <header className="home-header"><div><span className="wordmark">城影记</span><small>CITY MEMORIES</small></div>
          <div className="account-menu"><span>{session.user.username}</span>
            <button className="quiet-button" onClick={() => void logout()}>退出登录</button></div></header>
        <main className="empty-journal"><span className="journal-icon" aria-hidden="true">册</span>
          <p className="eyebrow">属于你的旅行记忆</p><h1>你好，{session.user.username}</h1>
          <p>你的账号已准备好。<br />城市与年份影集正在准备中，期待从下一段旅程开始。</p>
        </main>
      </div>
    } /><Route path="*" element={<Navigate to="/" replace />} /></Routes>
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
