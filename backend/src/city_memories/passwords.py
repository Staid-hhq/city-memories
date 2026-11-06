"""Bounded new-password policy. Existing passwords remain valid for authentication."""

COMMON_PASSWORDS = frozenset(
    {
        "12345678",
        "123456789",
        "1234567890",
        "87654321",
        "00000000",
        "11111111",
        "88888888",
        "password",
        "password1",
        "password123",
        "password123!",
        "qwertyui",
        "qwertyuiop",
        "qwerty123",
        "abcd1234",
        "abc12345",
        "iloveyou",
        "welcome1",
        "admin123",
        "admin12345",
        "letmein1",
        "changeme",
        "cijianji",
    }
)

# Only these fixed messages may cross the API boundary. Never copy validation
# input, context or an arbitrary exception message into an error response.
PASSWORD_ERRORS = {
    "current_password_length": (
        "CURRENT_PASSWORD_LENGTH", "当前密码长度须为 8–128 个字符。"
    ),
    "password_length": ("PASSWORD_LENGTH", "密码长度须为 8–16 位。"),
    "password_characters": (
        "PASSWORD_CHARACTERS",
        "密码仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。",
    ),
    "password_common": ("PASSWORD_COMMON", "该密码过于常见，请换一个不易猜到的密码。"),
    "password_confirm_length": ("PASSWORD_CONFIRM_LENGTH", "确认密码长度须为 8–16 位。"),
    "password_confirm_characters": (
        "PASSWORD_CONFIRM_CHARACTERS",
        "确认密码仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。",
    ),
    "password_confirm_common": (
        "PASSWORD_CONFIRM_COMMON",
        "确认密码过于常见，请换一个不易猜到的密码。",
    ),
    "password_mismatch": ("PASSWORD_MISMATCH", "两次输入的密码不一致，请重新核对。"),
}


def registration_password_issue(value: str) -> str | None:
    if not 8 <= len(value) <= 16:
        return "length"
    if any(not "!" <= character <= "~" for character in value):
        return "characters"
    # Case-insensitive whole-string comparison only. The password supplied to
    # the hasher is always the unmodified original value.
    if value.lower() in COMMON_PASSWORDS:
        return "common"
    return None
