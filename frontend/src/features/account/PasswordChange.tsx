import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError, errorMessage, setCsrfToken } from '../../shared/api'
import type { User } from '../../shared/api'
import { authErrorMessage, authResultUnknown, readAuthState, withAuthDeadline } from '../../shared/auth'
import { registrationPasswordError } from '../../shared/passwords'

type Field = 'current' | 'password' | 'confirmation'
type Values = Record<Field, string>
type Errors = Partial<Record<Field, string>>
const fields: Field[] = ['current', 'password', 'confirmation']
const definitions = {
  current: { id: 'current-password', label: '当前密码', help: '请输入当前密码', autoComplete: 'current-password' },
  password: { id: 'new-password', label: '新密码', help: '密码为 8–16 位，支持英文字母、数字和英文符号，不支持中文或空格。', autoComplete: 'new-password' },
  confirmation: { id: 'new-password-confirm', label: '确认新密码', help: '请再次输入新密码', autoComplete: 'new-password' },
}
const emptyValues: Values = { current: '', password: '', confirmation: '' }

function validate(values: Values): Errors {
  const errors: Errors = {}
  const length = [...values.current].length
  if (length < 8 || length > 128) errors.current = '当前密码长度须为 8–128 个字符。'
  const password = registrationPasswordError(values.password)
  const confirmation = registrationPasswordError(values.confirmation, true)
  if (password) errors.password = password
  else if (!errors.current && values.password === values.current) errors.password = '新密码不能与当前密码相同。'
  if (confirmation) errors.confirmation = confirmation
  else if (!password && values.password !== values.confirmation) errors.confirmation = '两次输入的密码不一致，请重新核对。'
  return errors
}

function errorField(error: unknown): Field | undefined {
  if (!(error instanceof ApiError)) return
  if (error.status === 400 && error.code === 'CURRENT_PASSWORD_INCORRECT') return 'current'
  if (error.status !== 422) return
  const mapping: Record<string, Field | undefined> = {
    CURRENT_PASSWORD_LENGTH: 'current', PASSWORD_UNCHANGED: 'password',
    PASSWORD_LENGTH: 'password', PASSWORD_CHARACTERS: 'password', PASSWORD_COMMON: 'password',
    PASSWORD_CONFIRM_LENGTH: 'confirmation', PASSWORD_CONFIRM_CHARACTERS: 'confirmation',
    PASSWORD_CONFIRM_COMMON: 'confirmation', PASSWORD_MISMATCH: 'confirmation',
  }
  return Object.hasOwn(mapping, error.code) ? mapping[error.code] : undefined
}

export function PasswordChange({ user, onPending, onLoginRequired }: {
  user: User; onPending: (pending: boolean) => void; onLoginRequired: (message: string, changed?: boolean) => void
}) {
  const navigate = useNavigate()
  const [values, setValues] = useState<Values>(emptyValues)
  const [visible, setVisible] = useState<Partial<Record<Field, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [unknown, setUnknown] = useState(false)
  const [error, setError] = useState('')
  const [serverError, setServerError] = useState<{ field: Field; message: string; code: string } | null>(null)
  const [focus, setFocus] = useState<{ field: Field } | null>(null)
  const lastFocus = useRef<typeof focus>(null)
  const inputs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({})
  const recovery = useRef<HTMLDivElement>(null)
  const operation = useRef(0)
  const active = useRef<AbortController | null>(null)
  const errors = submitted && !unknown ? validate(values) : {}
  if (serverError && !unknown) errors[serverError.field] = serverError.message
  const first = fields.find(field => errors[field])
  const alert = error || (first ? errors[first] : '')

  useEffect(() => () => { operation.current++; active.current?.abort(); onPending(false) }, [onPending])
  useEffect(() => {
    if (focus && !busy && lastFocus.current !== focus) {
      lastFocus.current = focus; inputs.current[focus.field]?.focus()
    }
  }, [focus, busy])
  useEffect(() => { if (unknown) recovery.current?.focus() }, [unknown])
  useEffect(() => {
    if (!busy) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [busy])

  function update(field: Field, value: string) {
    setValues(previous => ({ ...previous, [field]: value })); setError('')
    setServerError(previous => previous?.field === field || (
      previous?.code === 'PASSWORD_MISMATCH' && (field === 'password' || field === 'confirmation')
    ) || (previous?.code === 'PASSWORD_UNCHANGED' && (field === 'current' || field === 'password')) ? null : previous)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || unknown) return
    setSubmitted(true); setError(''); setServerError(null)
    const local = validate(values), first = fields.find(field => local[field])
    if (first) { setFocus({ field: first }); return }
    const controller = new AbortController(), id = ++operation.current
    active.current = controller
    const current = () => operation.current === id && !controller.signal.aborted
    let awaitingLogin = false
    let writeStarted = false
    onPending(true); setBusy(true)
    try {
      await withAuthDeadline(controller.signal, async signal => {
        const snapshot = await readAuthState(signal)
        signal.throwIfAborted()
        if (!current()) throw new DOMException('操作已改变', 'AbortError')
        if (!snapshot.user) throw new ApiError(401, 'AUTH_REQUIRED', '登录状态已失效，请重新登录。')
        if (snapshot.user.id !== user.id) throw new ApiError(409, 'ACCOUNT_CHANGED', '浏览器账号已变化，请重新登录后再修改密码。')
        setCsrfToken(snapshot.csrfToken)
        writeStarted = true
        const result = await api<null>('/auth/password', {
          method: 'POST', signal, body: JSON.stringify({ expected_user_id: user.id,
            current_password: values.current, password: values.password, password_confirm: values.confirmation }),
        }, false)
        if (result !== null) throw new ApiError(200, 'RESPONSE_INVALID', '修改密码响应无法识别，请重新登录核对。')
      })
      if (current()) {
        setValues(emptyValues); setVisible({})
        onLoginRequired('密码已修改，请使用新密码登录。', true)
      }
    } catch (reason) {
      if (!current()) return
      if (reason instanceof ApiError && (reason.status === 401 || (reason.status === 409 && reason.code === 'ACCOUNT_CHANGED'))) {
        setValues(emptyValues); setVisible({})
        onLoginRequired(reason.status === 401 ? '登录状态已失效，请重新登录。' : '浏览器账号已变化，请重新登录后再修改密码。')
      } else if (authResultUnknown(reason) && !writeStarted) {
        setError(reason instanceof DOMException && reason.name === 'TimeoutError'
          ? '核对登录状态等待超过 15 秒，尚未提交修改，请重试。'
          : '无法核对登录状态，尚未提交修改。' + errorMessage(reason))
      } else if (authResultUnknown(reason)) {
        awaitingLogin = true
        setValues(emptyValues); setVisible({}); setUnknown(true)
        setError(authErrorMessage(reason, errorMessage))
      } else {
        const field = errorField(reason)
        if (field && reason instanceof ApiError) {
          setServerError({ field, code: reason.code, message: errorMessage(reason) }); setFocus({ field })
        } else setError(authErrorMessage(reason, errorMessage))
      }
    } finally {
      if (current()) { setBusy(false); if (!awaitingLogin) onPending(false) }
    }
  }

  return <main className="password-settings"><section className="auth-card" aria-labelledby="change-password-title">
    <p className="eyebrow">账号 · {user.username}</p><h1 id="change-password-title">修改密码</h1>
    <p className="auth-description">修改成功后，此账号在所有浏览器和设备上的登录都会失效，请使用新密码重新登录。</p>
    <form onSubmit={submit} noValidate aria-busy={busy}>
      <input className="sr-only" name="username" autoComplete="username" value={user.username} readOnly tabIndex={-1} aria-label="当前用户名" />
      {fields.map(field => {
        const definition = definitions[field]
        return <div key={field}>
          <label htmlFor={definition.id}>{definition.label}</label><div className="password-field">
            <input id={definition.id} name={field === 'current' ? 'current_password' : field === 'confirmation' ? 'password_confirm' : 'password'}
              ref={node => { inputs.current[field] = node }} type={visible[field] ? 'text' : 'password'} required disabled={busy || unknown}
              autoComplete={definition.autoComplete} autoCapitalize="none" spellCheck={false}
              value={values[field]} onChange={event => update(field, event.target.value)}
              aria-invalid={errors[field] ? true : undefined} aria-describedby={`${definition.id}-help${errors[field] ? ` ${definition.id}-error` : ''}`} />
            <button type="button" className="quiet-button password-toggle" disabled={busy || unknown}
              aria-label={`${visible[field] ? '隐藏' : '显示'}${definition.label}`} aria-pressed={!!visible[field]} aria-controls={definition.id}
              onClick={() => setVisible(previous => ({ ...previous, [field]: !previous[field] }))}>{visible[field] ? '隐藏' : '显示'}</button>
          </div><p className="field-help" id={`${definition.id}-help`}>{definition.help}</p>
          {errors[field] && <p className="auth-field-error" id={`${definition.id}-error`}>{errors[field]}</p>}
        </div>
      })}
      {alert && <p className={error ? 'form-error' : 'auth-error-announcement'} role="alert">{alert}</p>}
      {unknown && <div className="auth-recovery password-change-recovery" role="status" tabIndex={-1} ref={recovery}>
        <p>修改结果尚未确认</p><p>密码可能已经修改。请先尝试新密码；若无法登录，再尝试原密码。不要重复提交修改。</p>
        <button type="button" className="quiet-button" onClick={() => onLoginRequired('修改结果尚未确认，请先尝试新密码；若无法登录，再尝试原密码。')}>前往登录核对</button>
      </div>}
      <button type="submit" className="primary-button" disabled={busy || unknown}>{busy ? '正在修改…' : '确认修改密码'}</button>
      {!unknown && <button type="button" className="quiet-button password-cancel" disabled={busy} onClick={() => navigate('/')}>取消</button>}
    </form>
  </section></main>
}
