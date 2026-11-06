import { ApiError } from './api'
import { registrationPasswordError } from './passwords'

export type AuthField = 'username' | 'password' | 'confirmation'
export type AuthValues = Record<AuthField, string>
export type AuthFieldErrors = Partial<Record<AuthField, string>>
export const authFieldOrder: AuthField[] = ['username', 'password', 'confirmation']

export function validateAuthFields(values: AuthValues, register: boolean): AuthFieldErrors {
  const errors: AuthFieldErrors = {}
  if (!/^[A-Za-z0-9_]{3,32}$/.test(values.username)) errors.username = '用户名须为 3–32 位英文字母、数字或下划线。'
  if (register) {
    const password = registrationPasswordError(values.password)
    const confirmation = registrationPasswordError(values.confirmation, true)
    if (password) errors.password = password
    if (confirmation) errors.confirmation = confirmation
    else if (!password && values.password !== values.confirmation) errors.confirmation = '两次输入的密码不一致，请重新核对。'
  } else {
    const length = [...values.password].length
    if (length < 8 || length > 128) errors.password = '密码长度须为 8–128 个字符。'
  }
  return errors
}

// Only documented registration responses identify a field. Never infer which
// login credential was wrong, or turn transport/service failures into fields.
export function registrationErrorField(error: unknown, register: boolean): AuthField | undefined {
  if (!register || !(error instanceof ApiError)) return undefined
  if (error.status === 409 && error.code === 'USERNAME_TAKEN') return 'username'
  if (error.status !== 422) return undefined
  const fields: Record<string, AuthField | undefined> = {
    PASSWORD_LENGTH: 'password', PASSWORD_CHARACTERS: 'password', PASSWORD_COMMON: 'password',
    PASSWORD_CONFIRM_LENGTH: 'confirmation', PASSWORD_CONFIRM_CHARACTERS: 'confirmation',
    PASSWORD_CONFIRM_COMMON: 'confirmation', PASSWORD_MISMATCH: 'confirmation',
  }
  return Object.hasOwn(fields, error.code) ? fields[error.code] : undefined
}
