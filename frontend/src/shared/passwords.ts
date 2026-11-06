const commonPasswords = new Set([
  '12345678', '123456789', '1234567890', '87654321', '00000000', '11111111', '88888888',
  'password', 'password1', 'password123', 'password123!', 'qwertyui', 'qwertyuiop', 'qwerty123',
  'abcd1234', 'abc12345', 'iloveyou', 'welcome1', 'admin123', 'admin12345', 'letmein1',
  'changeme', 'cijianji',
])

export function registrationPasswordError(value: string, confirmation = false): string | null {
  const field = confirmation ? '确认密码' : '密码'
  const length = [...value].length
  if (length < 8 || length > 16) return `${field}长度须为 8–16 位。`
  if (!/^[!-~]+$/.test(value)) return `${field}仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。`
  // Compare only for the bounded common-password check; never change the submitted value.
  if (commonPasswords.has(value.toLowerCase())) return confirmation
    ? '确认密码过于常见，请换一个不易猜到的密码。'
    : '该密码过于常见，请换一个不易猜到的密码。'
  return null
}
