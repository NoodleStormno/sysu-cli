---
name: sysu-cli-skill
description: Query and interact with Sun Yat-sen University (SYSU / 中山大学) campus services via the local `sysu-cli` tool: undergraduate academic services (jwxt.sysu.edu.cn), library OPAC holdings, sports venue availability & single-request booking (gym.sysu.edu.cn), and USC / Payment Hall services (usc.sysu.edu.cn / pay.sysu.edu.cn). Reuses browser login sessions without handling passwords and strictly prohibits high-frequency access.
version: 0.3.0
license: MIT
---

# SYSU Campus Services Skill (`sysu-cli`)

`sysu-cli` is the single source of truth. This skill tells the agent which command to run, how to handle its JSON output, and what safety/rate-limit rules must never be violated.

## Strict Anti-High-Frequency & Rate-Limit Rules (严禁高频访问限制)

- **严禁高频访问与轮询（NO High-Frequency Polling or Burst Loops）**：
  - 绝不允许通过 `while`/`for` 循环、定时脚本、后台高频轮询或并发请求连续调用任何 `sysu-cli` 命令（包括但不限于持续监控体育场余量、定时毫秒级连发抢场、批量爬取图书馆或全校开课目录）。
  - 每次用户对话回合中，针对同一资源的查询最多执行 **1 次**；如需分页或跟进查询，单回合内总调用次数不得超过 **3 次**。
- **体育场馆订场仅限单次按需请求（Single-Request Booking Only）**：
  - `sysu-cli gym book` 与 `sysu-cli gym cancel` 内置跨进程冷却锁（`~/.sysu-cli/rate-limit.json`）。
  - 仅在用户明确告知目标场馆、日期、时间段后发起**单次** `gym book`（或 `--waitlist` 候补）。如果返回场地已满、`UPSTREAM_ERROR` 或 `RATE_LIMITED`，**必须立即停止并向用户汇报结果，严禁自动循环重试或抢场**。
- **遇到限流立即熔断**：一旦任何命令返回 `error.code === "RATE_LIMITED"` 或 WAF 拦截提示，必须立即停止所有后续调用，不得重试。

## Security & Privacy Rules

- **Never** ask for the user's NetID password, verification code, or cookie files.
- **Never** bypass unified authentication, Geetest slider verification, Safeline WAF, WeCom QR confirmation, or campus-network / VPN requirements.
- Run **one** browser login command (`auth login`, `gym login`, `usc login`) at a time.
- Every command outputs JSON `{ ok, command, data | error }`. Parse JSON; do not scrape prose.
- Treat grades, GPA, rank, student identifiers, and wallet balances as private: report only what the user asked for.

## Readiness & Login Flow

1. **JWXT (本科教务系统 `jwxt.sysu.edu.cn`)**:
   - Check status: `sysu-cli auth status`
   - If `loggedIn: false`, try `sysu-cli auth refresh` once; if it still returns `LOGIN_REQUIRED`, run `sysu-cli auth login` and ask the user to complete login in the opened browser window.
2. **Library OPAC (图书馆馆藏检索)**:
   - No login is required. `sysu-cli library search` and `sysu-cli library holdings` work directly on the campus network / VPN.
3. **Sports Venues (`gym.sysu.edu.cn`)**:
   - If any `gym` command returns `LOGIN_REQUIRED`, run `sysu-cli gym login` once and ask the user to finish CAS login in the opened browser window so `sysu-cli` can save the Scientia Bearer JWT.
4. **University Service Center & Payment Hall (`usc.sysu.edu.cn` / `pay.sysu.edu.cn`)**:
   - If any `usc` or `fee` command returns `LOGIN_REQUIRED`, run `sysu-cli usc login` once and wait for the user to finish login in the opened browser window.
5. **Online Learning Platform (`lms.sysu.edu.cn` Moodle)**:
   - `sysu-cli lms categories` and `sysu-cli lms search` work without login.
   - If `lms courses`, `lms deadlines`, `lms tasks`, or `lms quiz` returns `LOGIN_REQUIRED`, run `sysu-cli lms login` once (it will try silent CAS SSO first, or open a browser window if needed).

## Command Routing

| User intent | Command |
|---|---|
| Current academic year/semester and teaching week | `sysu-cli term current` |
| This week's timetable / a specific week or weekday | `sysu-cli course list [--term YYYY-N] [--week N] [--weekday 1..7]` |
| Today's or a specific date's classes | `sysu-cli course today [--date YYYY-MM-DD]` |
| Export timetable to `.ics` calendar | `sysu-cli course export-ics [--term YYYY-N] [--week N \| --from-week M --to-week N] [--out schedule.ics]` |
| Semester grades, weighted GPA, and rank | `sysu-cli grade list [--term YYYY-N]` |
| Credit completion overview & score distribution | `sysu-cli grade credits` |
| Available exam weeks in a term | `sysu-cli exam weeks [--term YYYY-N]` |
| Exam schedule (all or filtered) | `sysu-cli exam list [--term YYYY-N] [--type "18-19周期末考"\|"10-17周结课考"\|"缓补考"] [--week-id ID]` |
| List campuses / teaching buildings | `sysu-cli classroom campuses` / `sysu-cli classroom buildings [--campus 校区]` |
| Find empty classrooms in a building | `sysu-cli classroom empty --building 教学楼 [--campus 校区] [--date YYYY-MM-DD] [--sections 1-2] [--all]` |
| CET-4 / CET-6 scores | `sysu-cli cet list [--level 4\|6]` |
| Undergraduate Office & college notices | `sysu-cli notice list [--category all\|education\|college] [--search 关键词] [--limit 20]` |
| Graduation credit completion audit | `sysu-cli completion summary` / `sysu-cli completion courses [--category 代码] [--search 关键词]` |
| Personal training program (个人培养方案) | `sysu-cli program view [--category publicRequired\|...] [--search 关键词]` |
| Search university-wide course offerings | `sysu-cli catalog search [--term YYYY-N] [--name 课程名] [--teacher 教师] [--department 院系] [--campus 校区]` |
| Student academic record & warnings | `sysu-cli profile view` |
| Search library books & campus call numbers | `sysu-cli library search --query 关键词 [--field any\|title\|author\|isbn\|callno] [--lang zh\|en] [--campus 校区]` |
| Check per-copy on-shelf status & shelf location | `sysu-cli library holdings --doc 书目号 [--lang zh\|en] [--campus 校区] [--available]` |
| Authenticate with `gym.sysu.edu.cn` | `sysu-cli gym login` |
| List sports venues across campuses | `sysu-cli gym venues [--campus 校区] [--search 关键词]` |
| Check court & timeslot availability | `sysu-cli gym slots --venue 场馆名或ID [--date YYYY-MM-DD] [--time HH:MM] [--court 场地名] [--available]` |
| View sports credits, wallet & my bookings | `sysu-cli gym me` |
| Book a court (single request only, no loops) | `sysu-cli gym book --venue 场馆名或ID --date YYYY-MM-DD --time HH:MM [--court 场地名] [--waitlist] [--cash]` |
| Cancel a gym booking or waitlist entry | `sysu-cli gym cancel --id 预约UUID或订单号` |
| Authenticate with `usc.sysu.edu.cn` & `pay.sysu.edu.cn` | `sysu-cli usc login` |
| Search USC campus service items | `sysu-cli usc services [--search 关键词] [--limit 20]` |
| List personal USC workflow tasks | `sysu-cli usc tasks [--type todo\|done\|complete]` |
| List unpaid bills in SYSU Payment Hall | `sysu-cli fee unpaid` |
| Authenticate with `lms.sysu.edu.cn` | `sysu-cli lms login` |
| Browse or search LMS courses | `sysu-cli lms categories` / `sysu-cli lms search --query 关键词` |
| List my enrolled LMS courses & progress | `sysu-cli lms courses [--status all\|inprogress\|past\|future] [--search 关键词]` |
| List upcoming LMS assignment & quiz DDLs | `sysu-cli lms deadlines [--days 30]` |
| Extract course task links / batch-open in browser | `sysu-cli lms tasks --course 课程ID [--type video\|quiz\|assign\|all] [--todo] [--open] [--limit 5]` |
| Extract quiz questions & options as plain text | `sysu-cli lms quiz --id 测验ID或URL [--attempt 作答ID] [--start]` |
| Environment / network diagnosis | `sysu-cli doctor` |
| Disconnect & wipe local session | `sysu-cli auth logout` |

Term format is `YYYY-N` where `YYYY` is the start year of the academic year (for example, `2026-1` means the first semester of 2026–2027; `2026-2027-1` is also accepted). Omit `--term` to query the current term.

## Error Handling (`error.code`)

- `LOGIN_REQUIRED` → run the corresponding login command (`sysu-cli auth refresh` / `sysu-cli auth login` for JWXT, `sysu-cli gym login` for Gym, `sysu-cli usc login` for USC/Payment Hall) and wait for the user.
- `RATE_LIMITED` → **stop immediately**; do not retry or loop.
- `BROWSER_UNAVAILABLE` → tell the user to install Chrome/Edge or run `npx playwright install chromium`.
- `BROWSER_BUSY` → another `sysu-cli` browser window is open; wait or ask the user to close it.
- `NETWORK_ERROR` → remind the user that SYSU services require the campus network or SYSU VPN.
- `UPSTREAM_CHANGED` → re-run once with `--raw` to inspect the raw payload, or use `sysu-cli dev capture` with the user to inspect current endpoints.
