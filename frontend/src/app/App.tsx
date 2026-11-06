import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { api, ApiError, clearSessionState, errorMessage, isAbort, setCsrfToken } from '../shared/api'
import type { LoginResult, User } from '../shared/api'
import { OperationFeedback } from '../shared/OperationFeedback'
import { authErrorMessage, authResultUnknown, isUser, readAuthState, withAuthDeadline } from '../shared/auth'
import { authFieldOrder, registrationErrorField, validateAuthFields } from '../shared/authFields'
import type { AuthField } from '../shared/authFields'
import { Journal } from '../features/albums/Journal'

type SessionState =
  | { phase: 'loading' | 'guest' | 'logging-out' | 'logout-error'; message?: string }
  | { phase: 'error'; error: unknown }
  | { phase: 'user'; user: User }

async function readSession(controller: AbortController) {
  return withAuthDeadline(controller.signal, async signal => {
    const user = await api<User>('/auth/me', { signal }, false)
    if (!isUser(user)) throw new ApiError(200, 'RESPONSE_INVALID', '登录状态响应无法识别，请重新连接后再试。')
    return user
  })
}

function connectionTitle(error: unknown) {
  if (error instanceof DOMException && error.name === 'TimeoutError') return '连接等待超时'
  if (error instanceof ApiError && error.status >= 500) return '服务暂时不可用'
  if (error instanceof ApiError && error.code === 'RESPONSE_INVALID') return '服务响应无法识别'
  return '暂时无法连接此间集'
}

function connectionDescription(error: unknown) {
  return error instanceof DOMException && error.name === 'TimeoutError'
    ? '等待服务响应超过 15 秒，请确认服务已就绪后重新连接。'
    : errorMessage(error)
}

function ConnectionHelp() {
  return <details className="connection-help"><summary>查看本机启动步骤</summary>
    <ol><li>在 PyCharm 选择“此间集－启动”，确认前后端都已运行完成。</li>
      <li>如果只启动了网页，请启动“此间集－后端”；已有服务时不用重复运行。</li>
      <li>服务就绪后点击“重新连接”。仍未恢复时，查看 PyCharm 运行窗口中的报错。</li></ol>
    <p>连接提示无法确定具体原因；服务未就绪或连接中断都可能导致当前情况。</p>
    {navigator.onLine === false && <p>浏览器提示当前离线，恢复连接后可再试一次。</p>}
  </details>
}

function AuthPage({ register, onLogin }: { register: boolean; onLogin: (user: User) => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState<string>(location.state?.registeredUsername ?? location.state?.recoveryUsername ?? '')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [serverFieldError, setServerFieldError] = useState<{ field: AuthField; message: string; code: string } | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ field: AuthField } | null>(null)
  const lastFocused = useRef<typeof focusRequest>(null)
  const fieldInputs = useRef<Record<AuthField, HTMLInputElement | null>>({ username: null, password: null, confirmation: null })
  const [recovery, setRecovery] = useState<{ kind: 'login' | 'register'; username: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const operation = useRef(0)
  const recoveryPanel = useRef<HTMLDivElement | null>(null)
  const notice = location.state?.registeredUsername ? '账号已创建，请使用新密码登录。'
    : location.state?.recoveryUsername ? '注册结果尚未确认，请尝试登录。' : ''
  const activeRequest = useRef<AbortController | null>(null)
  const fieldErrors = submitted && !recovery ? validateAuthFields({ username, password, confirmation }, register) : {}
  if (serverFieldError && !recovery) fieldErrors[serverFieldError.field] = serverFieldError.message
  const firstErrorField = authFieldOrder.find(field => fieldErrors[field])
  const alertMessage = error || (firstErrorField ? fieldErrors[firstErrorField] : '')

  useEffect(() => () => { operation.current++; activeRequest.current?.abort() }, [])
  useEffect(() => { if (recovery) recoveryPanel.current?.focus() }, [recovery])
  useEffect(() => {
    if (focusRequest && !busy && lastFocused.current !== focusRequest) {
      lastFocused.current = focusRequest
      fieldInputs.current[focusRequest.field]?.focus()
    }
  }, [focusRequest, busy])

  function updateField(field: AuthField, value: string) {
    if (field === 'username') setUsername(value)
    else if (field === 'password') setPassword(value)
    else setConfirmation(value)
    setError('')
    setServerFieldError(previous => previous?.field === field || (
      previous?.code === 'PASSWORD_MISMATCH' && (field === 'password' || field === 'confirmation')
    ) ? null : previous)
  }

  function begin() {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    const id = ++operation.current
    return { controller, current: () => operation.current === id && !controller.signal.aborted }
  }

  async function checkLogin() {
    if (!recovery || recovery.kind !== 'login' || busy) return
    clearSessionState()
    const { controller, current } = begin()
    setBusy(true); setChecking(true); setError('')
    try {
      const snapshot = await withAuthDeadline(controller.signal, readAuthState)
      if (!current()) return
      setCsrfToken(snapshot.csrfToken)
      if (!snapshot.user) {
        setRecovery(null)
        setError('当前未登录，可重新登录；这不代表之前的请求未被处理。')
      } else if (snapshot.user.username.toLowerCase() !== recovery.username.toLowerCase()) {
        setError('当前浏览器登录的账号与本次输入不一致，请重新填写并登录，或刷新页面核对账号。')
      } else {
        setPassword(''); setConfirmation('')
        onLogin(snapshot.user)
      }
    } catch (reason) {
      if (current()) setError(authErrorMessage(reason, errorMessage))
    } finally {
      if (current()) { setBusy(false); setChecking(false) }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || recovery) return
    setError('')
    setSubmitted(true); setServerFieldError(null)
    const errors = validateAuthFields({ username, password, confirmation }, register)
    const first = authFieldOrder.find(field => errors[field])
    if (first) {
      setFocusRequest({ field: first })
      return
    }
    setBusy(true)
    const { controller, current } = begin()
    const submittedUsername = username
    try {
      if (register) {
        const result = await withAuthDeadline(controller.signal, signal => api<User>('/auth/register', {
          method: 'POST', signal,
          body: JSON.stringify({ username, password, password_confirm: confirmation }),
        }, false))
        if (!current()) return
        if (!isUser(result) || result.username.toLowerCase() !== submittedUsername.toLowerCase()) throw new ApiError(200, 'RESPONSE_INVALID', '注册响应无法识别，请尝试登录核对结果。')
        setPassword('')
        setConfirmation('')
        navigate('/login', { replace: true, state: { registeredUsername: username } })
      } else {
        const result = await withAuthDeadline(controller.signal, signal => api<LoginResult>('/auth/login', {
          method: 'POST', signal, body: JSON.stringify({ username, password }),
        }, false))
        if (!current()) return
        if (!isUser(result?.user) || result.user.username.toLowerCase() !== submittedUsername.toLowerCase() || typeof result.csrf_token !== 'string' || !result.csrf_token.trim()) {
          throw new ApiError(200, 'RESPONSE_INVALID', '登录响应无法识别，请重新核对登录结果后再试。')
        }
        setPassword('')
        clearSessionState()
        setCsrfToken(result.csrf_token)
        onLogin(result.user)
      }
    } catch (reason: unknown) {
      if (!current()) return
      if (authResultUnknown(reason)) {
        setError(authErrorMessage(reason, errorMessage))
        clearSessionState()
        setShowPassword(false); setShowConfirmation(false)
        setRecovery({ kind: register ? 'register' : 'login', username: submittedUsername })
      } else {
        const field = registrationErrorField(reason, register)
        if (field && reason instanceof ApiError) {
          setServerFieldError({ field, message: errorMessage(reason), code: reason.code })
          setFocusRequest({ field })
        } else setError(authErrorMessage(reason, errorMessage))
      }
    } finally {
      if (current()) setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="journal-intro" aria-labelledby="brand-title">
        <p className="eyebrow">CIJIANJI · 私人旅行手帐</p>
        <h1 id="brand-title">此间集</h1>
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
        <form onSubmit={submit} aria-busy={busy} noValidate>
          <label htmlFor="username">用户名</label>
          <input id="username" name="username" autoComplete="username" required maxLength={32}
            ref={node => { fieldInputs.current.username = node }}
            value={username} onChange={(event) => updateField('username', event.target.value)}
            aria-invalid={fieldErrors.username ? true : undefined}
            aria-describedby={fieldErrors.username ? 'username-help username-error' : 'username-help'} disabled={busy} placeholder="例如 slow_traveler" />
          <p id="username-help" className="field-help">3–32 位英文字母、数字或下划线，不区分大小写。</p>
          {fieldErrors.username && <p id="username-error" className="auth-field-error">{fieldErrors.username}</p>}
          <label htmlFor="password">密码</label>
          <div className="password-field">
            <input id="password" name="password" type={showPassword ? 'text' : 'password'} required disabled={busy}
              ref={node => { fieldInputs.current.password = node }}
              autoComplete={register ? 'new-password' : 'current-password'} autoCapitalize="none" spellCheck={false} value={password}
              onChange={(event) => updateField('password', event.target.value)} aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={fieldErrors.password ? 'password-help password-error' : 'password-help'} />
            <button className="quiet-button password-toggle" type="button" disabled={busy}
              aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} aria-controls="password"
              onClick={() => setShowPassword(value => !value)}>{showPassword ? '隐藏' : '显示'}</button>
          </div>
          <p id="password-help" className="field-help">{register ? '密码为 8–16 位，支持英文字母、数字和英文符号，不支持中文或空格。' : '请输入密码'}</p>
          {fieldErrors.password && <p id="password-error" className="auth-field-error">{fieldErrors.password}</p>}
          {register && <>
            <label htmlFor="password-confirm">确认密码</label>
            <div className="password-field">
              <input id="password-confirm" name="password_confirm" type={showConfirmation ? 'text' : 'password'} required disabled={busy}
                ref={node => { fieldInputs.current.confirmation = node }}
                autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={confirmation}
                onChange={(event) => updateField('confirmation', event.target.value)} aria-invalid={fieldErrors.confirmation ? true : undefined}
                aria-describedby={fieldErrors.confirmation ? 'password-help password-confirm-error' : 'password-help'} />
              <button className="quiet-button password-toggle" type="button" disabled={busy}
                aria-label={showConfirmation ? '隐藏确认密码' : '显示确认密码'} aria-pressed={showConfirmation} aria-controls="password-confirm"
                onClick={() => setShowConfirmation(value => !value)}>{showConfirmation ? '隐藏' : '显示'}</button>
            </div>
            {fieldErrors.confirmation && <p id="password-confirm-error" className="auth-field-error">{fieldErrors.confirmation}</p>}
          </>}
          {alertMessage && <p className={error ? 'form-error' : 'auth-error-announcement'} role="alert">{alertMessage}</p>}
          {recovery && <div className="auth-recovery" role="status" tabIndex={-1} ref={recoveryPanel}>
            <p>{recovery.kind === 'login' ? '登录结果尚未确认' : '注册结果尚未确认'}</p>
            <p>{recovery.kind === 'login'
              ? '请先核对当前登录状态；超时或停止等待不会撤销服务端操作。'
              : '账号可能已创建，请用刚才的用户名和密码尝试登录。不要重复提交注册。'}</p>
            {recovery.kind === 'login' ? <>
              <button className="quiet-button" type="button" disabled={busy} onClick={() => void checkLogin()}>{checking ? '正在核对…' : '核对登录状态'}</button>
              <button className="quiet-button" type="button" disabled={busy} onClick={() => { setRecovery(null); setError('请核对账号和密码后再明确提交登录。') }}>重新填写并登录</button>
            </> : <Link className="quiet-button" to="/login" state={{ recoveryUsername: recovery.username }}>前往登录</Link>}
          </div>}
          {notice && <p role="status">{notice}</p>}
          <button className="primary-button" type="submit" disabled={busy || recovery !== null}>
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
  const logoutOwner = useRef<User | null>(null)
  const logoutOperation = useRef(0)
  const logoutRequest = useRef<AbortController | null>(null)
  const [checkingLogout, setCheckingLogout] = useState(false)
  const [logoutAccountChanged, setLogoutAccountChanged] = useState(false)
  const logoutFeedback = useRef<HTMLElement | null>(null)
  const sessionRequest = useRef<AbortController | null>(null)
  const checkRequest = useRef<AbortController | null>(null)
  const [sessionNotice, setSessionNotice] = useState<unknown>()
  const [checkingSession, setCheckingSession] = useState(false)

  useEffect(() => {
    if (session.phase === 'logout-error' && !checkingLogout) logoutFeedback.current?.focus()
  }, [session.phase, checkingLogout])

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
    bus.onmessage = () => {
      if (logoutPending.current) {
        logoutOperation.current++; logoutRequest.current?.abort()
        clearSessionState(); setCheckingLogout(false); setLogoutAccountChanged(true)
        setSession({ phase: 'logout-error', message: '浏览器登录状态已变化，退出结果尚未确认，请先核对退出状态。' })
        return
      }
      refresh()
    }
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
      logoutRequest.current?.abort()
      clearSessionState()
      window.removeEventListener('city-memories:expired', expired)
      window.removeEventListener('pageshow', restored)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh, loadSession, verifySession])

  function loggedIn(user: User) {
    logoutPending.current = false
    logoutOwner.current = null; setCheckingLogout(false); setLogoutAccountChanged(false)
    activeUser.current = user.id; setSessionNotice(undefined)
    setSession({ phase: 'user', user })
    channel.current?.postMessage('changed')
    navigate('/', { replace: true })
  }

  function beginLogoutCheck() {
    logoutRequest.current?.abort()
    const controller = new AbortController()
    logoutRequest.current = controller
    const id = ++logoutOperation.current
    return { controller, current: () => logoutOperation.current === id && !controller.signal.aborted }
  }

  function finishLogout() {
    logoutOperation.current++; logoutRequest.current = null
    logoutOwner.current = null; setCheckingLogout(false); setLogoutAccountChanged(false)
    clearSessionState()
    logoutPending.current = false
    setSession({ phase: 'guest' })
    channel.current?.postMessage('changed')
    navigate('/login', { replace: true })
  }

  async function verifyLogout() {
    if (!logoutPending.current || checkingLogout) return
    clearSessionState()
    const { controller, current } = beginLogoutCheck()
    setCheckingLogout(true)
    try {
      const snapshot = await withAuthDeadline(controller.signal, readAuthState)
      if (!current()) return
      if (!snapshot.user) { finishLogout(); return }
      const changed = snapshot.user.id !== logoutOwner.current?.id
      setLogoutAccountChanged(changed)
      setSession({ phase: 'logout-error', message: changed
        ? '当前浏览器的账号已变化，未退出另一个账号。请重新连接核对。'
        : '当前仍处于登录状态，请选择重试退出。' })
    } catch (error) {
      if (current()) setSession({ phase: 'logout-error', message: '退出尚未完成，退出结果尚未确认。' + authErrorMessage(error, errorMessage) })
    } finally { if (current()) setCheckingLogout(false) }
  }

  async function logout() {
    const owner = logoutPending.current ? logoutOwner.current : session.phase === 'user' ? session.user : null
    if (!owner) return
    logoutOwner.current = owner
    logoutPending.current = true
    activeUser.current = null; setSessionNotice(undefined); setCheckingSession(false)
    sessionRequest.current?.abort(); checkRequest.current?.abort()
    clearSessionState()
    const { controller, current } = beginLogoutCheck()
    setCheckingLogout(false); setLogoutAccountChanged(false)
    setSession({ phase: 'logging-out' })
    try {
      const changed = await withAuthDeadline(controller.signal, async signal => {
        const snapshot = await readAuthState(signal)
        signal.throwIfAborted()
        if (!current()) throw new DOMException('操作已改变', 'AbortError')
        if (!snapshot.user) return false
        if (snapshot.user.id !== owner.id) return true
        setCsrfToken(snapshot.csrfToken)
        const result = await api<null>('/auth/logout', { method: 'POST', signal }, false)
        if (result !== null) throw new ApiError(200, 'RESPONSE_INVALID', '退出响应无法识别，请核对退出状态。')
        return false
      })
      if (!current()) return
      if (changed) {
        setLogoutAccountChanged(true)
        setSession({ phase: 'logout-error', message: '当前浏览器的账号已变化，未退出另一个账号。请重新连接核对。' })
        return
      }
      finishLogout()
    } catch (error: unknown) {
      if (current()) setSession({ phase: 'logout-error', message: '退出尚未完成，退出结果尚未确认。' + authErrorMessage(error, errorMessage) })
    }
  }

  if (session.phase !== 'guest' && session.phase !== 'user') {
    return <main className="status-page"><section className="status-card connection-card" ref={logoutFeedback} tabIndex={session.phase === 'logout-error' ? -1 : undefined}>
      <p className="eyebrow">CIJIANJI</p><h1>此间集</h1>
      {session.phase === 'loading' || session.phase === 'error' ? <>
        <OperationFeedback tone={session.phase === 'error' ? 'error' : 'progress'} title={session.phase === 'error' ? connectionTitle(session.error) : '正在连接此间集'}>
          <p>{session.phase === 'error' ? connectionDescription(session.error) : '正在确认服务和登录状态，请稍候。'}</p>
        </OperationFeedback>
        <button className="primary-button" onClick={refresh}>重新连接</button>
        <ConnectionHelp />
      </> : <p role={session.message && !checkingLogout ? 'alert' : 'status'}>{checkingLogout ? '正在核对退出状态…' : session.message ?? '正在退出…'}</p>}
      {session.phase === 'logout-error' && <>
        <button className="quiet-button" disabled={checkingLogout} onClick={() => void verifyLogout()}>核对退出状态</button>
        {logoutAccountChanged
          ? <button className="primary-button" disabled={checkingLogout} onClick={() => { logoutPending.current = false; logoutOwner.current = null; refresh() }}>重新连接并核对账号</button>
          : <button className="primary-button" disabled={checkingLogout} onClick={() => void logout()}>重试退出</button>}
      </>}
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
