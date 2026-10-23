---
name: sysu-cli-skill
description: Query Sun Yat-sen University (SYSU / 中山大学) undergraduate academic services (jwxt.sysu.edu.cn) via the local `sysu-cli` tool: timetable, today's courses, grades/GPA, credits, and exam schedules. Read-only; reuses a browser login session without handling passwords.
version: 0.1.0
license: MIT
---

# SYSU Campus Services Skill (`sysu-cli`)

`sysu-cli` is the single source of truth. This skill only tells the agent which command to run and how to handle its JSON output.

## Rules

- **Never** ask for the user's NetID password, verification code, or cookie files.
- **Never** bypass unified authentication, Geetest slider verification, WeCom QR confirmation, or campus-network / VPN requirements.
- Run **one** `auth` or browser command at a time. Regular data queries (`course`, `grade`, `exam`, `term`) use plain HTTP with saved cookies and do not open a browser.
- Every command outputs JSON `{ ok, command, data | error }`. Parse JSON; do not scrape prose.
- Treat grades, GPA, rank, and student identifiers as private: report only what the user asked for.
- Stop immediately on `RATE_LIMITED`. On `NETWORK_ERROR` or `UPSTREAM_ERROR`, retry at most once.

## Readiness & Login Flow

1. Check status:
   ```bash
   sysu-cli auth status
   ```
2. If `loggedIn: false`:
   - First try a silent renewal from the saved unified-auth browser profile:
     ```bash
     sysu-cli auth refresh
     ```
   - If that still returns `LOGIN_REQUIRED`, run:
     ```bash
     sysu-cli auth login
     ```
     and ask the user to complete login (NetID + slider or 企业微信扫码) in the opened browser window. The window closes automatically once JWXT confirms the session.

## Command Routing

| User intent | Command |
|---|---|
| Current academic year/semester and teaching week | `sysu-cli term current` |
| This week's timetable / a specific week or weekday | `sysu-cli course list [--term YYYY-N] [--week N] [--weekday 1..7]` |
| Today's or a specific date's classes | `sysu-cli course today [--date YYYY-MM-DD]` |
| Semester grades, weighted GPA, and rank | `sysu-cli grade list [--term YYYY-N]` |
| Credit completion overview & score distribution | `sysu-cli grade credits` |
| Available exam weeks in a term | `sysu-cli exam weeks [--term YYYY-N]` |
| Exam schedule (all or filtered) | `sysu-cli exam list [--term YYYY-N] [--type "18-19周期末考"\|"10-17周结课考"\|"缓补考"] [--week-id ID]` |
| Export timetable to `.ics` calendar | `sysu-cli course export-ics [--term YYYY-N] [--week N \| --from-week M --to-week N] [--out schedule.ics]` |
| List campuses / teaching buildings | `sysu-cli classroom campuses` / `sysu-cli classroom buildings [--campus 校区]` |
| Find empty classrooms in a building | `sysu-cli classroom empty --building 教学楼 [--campus 校区] [--date YYYY-MM-DD] [--sections 1-2] [--all]` |
| CET-4 / CET-6 scores | `sysu-cli cet list [--level 4\|6]` |
| Undergraduate Office & college notices | `sysu-cli notice list [--category all\|education\|college] [--search 关键词] [--limit 20]` |
| Graduation credit completion audit | `sysu-cli completion summary` / `sysu-cli completion courses [--category 代码] [--search 关键词]` |
| Personal training program (个人培养方案) | `sysu-cli program view [--category publicRequired\|...] [--search 关键词]` |
| Search university-wide course offerings | `sysu-cli catalog search [--term YYYY-N] [--name 课程名] [--teacher 教师] [--department 院系] [--campus 校区]` |
| Student academic record & warnings | `sysu-cli profile view` |
| Environment / network diagnosis | `sysu-cli doctor` |
| Disconnect & wipe local session | `sysu-cli auth logout` |

Term format is `YYYY-N` where `YYYY` is the start year of the academic year (for example, `2025-1` means the first semester of 2025–2026; `2025-2026-1` is also accepted). Omit `--term` to query the current term.

## Error Handling (`error.code`)

- `LOGIN_REQUIRED` → try `sysu-cli auth refresh` once; if it still fails, run `sysu-cli auth login` and wait for the user.
- `BROWSER_UNAVAILABLE` → tell the user to install Chrome/Edge or run `npx playwright install chromium`.
- `BROWSER_BUSY` → another `sysu-cli` browser window is open; wait or ask the user to close it.
- `NETWORK_ERROR` → remind the user that `jwxt.sysu.edu.cn` may require campus network or SYSU VPN.
- `UPSTREAM_CHANGED` → re-run once with `--raw` to inspect the raw payload, or use `sysu-cli dev capture` with the user to inspect current JWXT endpoints.
