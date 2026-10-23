# CLI Contract (`sysu-cli`)

Every invocation prints a single JSON object to `stdout`. Diagnostic progress (such as `auth login` browser prompts) goes to `stderr`.

## Success Envelope

```json
{
  "ok": true,
  "command": "course today",
  "data": { ... }
}
```

## Error Envelope & Exit Codes

```json
{
  "ok": false,
  "command": "course list",
  "error": {
    "code": "LOGIN_REQUIRED",
    "message": "No saved SYSU session was found.",
    "hint": "Run `sysu-cli auth refresh` ... or `sysu-cli auth login` ..."
  }
}
```

| Exit code | `error.code` | Meaning |
|---|---|---|
| `0` | — | Success |
| `2` | `UNKNOWN_COMMAND`, `INVALID_ARGUMENT` | CLI usage error; fix arguments and do not retry blindly |
| `3` | `LOGIN_REQUIRED`, `AUTH_LOGIN_INCOMPLETE`, `AUTH_LOGIN_TIMEOUT` | Session missing or expired; run `auth refresh` or `auth login` |
| `4` | `PERMISSION_DENIED`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `UPSTREAM_CHANGED` | Upstream rejected, rate-limited, or changed the response; stop immediately on `RATE_LIMITED` |
| `5` | `NETWORK_ERROR` | Cannot reach `jwxt.sysu.edu.cn` (campus network or SYSU VPN may be required) |
| `6` | `BROWSER_UNAVAILABLE`, `BROWSER_BUSY`, `BACKEND_UNAVAILABLE` | Local browser / Playwright issue |

## Term Format

`--term` accepts:
- `current` (default when omitted)
- `YYYY-N`, where `YYYY` is the start year of the academic year (`2026-1` = 2026–2027 学年第一学期, `2025-2` = 2025–2026 学年第二学期)
- `YYYY-YYYY-N` (`2026-2027-1`), automatically normalized to `YYYY-N`
