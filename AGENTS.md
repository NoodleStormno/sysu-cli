# sysu-cli Agent & Contributor Guide

`sysu-cli` is an agent-friendly CLI for Sun Yat-sen University campus services (`jwxt.sysu.edu.cn`, `library.sysu.edu.cn` OPAC, `gym.sysu.edu.cn`, `usc.sysu.edu.cn`, and `pay.sysu.edu.cn`).

## Design Principles

1. **Browser for login, plain HTTP for queries**: Playwright is only launched for `auth login`, `auth refresh`, `gym login`, `usc login`, and `dev capture`. Daily queries use Node.js `fetch` with tokens/cookies saved in `~/.sysu-cli/session.json` (`0600`).
2. **Structured JSON contract**: Every command writes `{ ok: true, command, data }` or `{ ok: false, command, error: { code, message, hint?, details? } }` to stdout and exits with a deterministic code (`0` ok, `2` usage/args, `3` auth, `4` upstream/permission/rate-limit, `5` network, `6` browser).
3. **Strict safety & anti-high-frequency boundary**:
   - Never ask for, accept, or store NetID passwords.
   - Never bypass unified authentication, Geetest slider verification, Safeline WAF, WeCom QR login, rate limits, or campus-network / VPN access controls.
   - **Prohibit high-frequency access**: All HTTP requests pass through `src/lib/rate-limit.js` (`paceRequest` for in-process pacing and `enforceActionCooldown` for cross-process action cooldowns). Never implement high-frequency polling, burst scraping, or automated court-sniping loops.
   - Never commit `session.json`, `rate-limit.json`, browser profiles, or `dev capture` output.

## Repository Layout

- `src/cli.js`: binary entrypoint.
- `src/main.js`: declarative command table (`COMMANDS`) and JSON output envelope.
- `src/lib/`: `jwxt.js` (HTTP + mock client), `rate-limit.js` (pacing & cooldown lock), `cookies.js`, `state.js`, `browser.js`, `args.js`, `errors.js`, `paths.js`.
- `src/modules/`: one file per domain (`auth`, `term`, `course`, `grade`, `exam`, `classroom`, `cet`, `notice`, `completion`, `program`, `catalog`, `profile`, `library`, `gym`, `usc`, `doctor`, `dev`).
- `src/parsers/`: pure functions that turn raw upstream payloads into stable JSON shapes.
- `skills/sysu-cli-skill/SKILL.md`: agent operating instructions and anti-high-frequency rules.
- `tests/`: `node --test` unit and contract tests backed by `SYSU_BACKEND=mock`.

## Verification

Run `npm test` before every commit. All tests must pass offline via `SYSU_BACKEND=mock`.
