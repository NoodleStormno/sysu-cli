# sysu-cli Agent & Contributor Guide

`sysu-cli` is an agent-friendly CLI for Sun Yat-sen University (`jwxt.sysu.edu.cn`) undergraduate academic services.

## Design Principles

1. **Browser for login, plain HTTP for queries**: Playwright is only launched for `auth login`, `auth refresh`, and `dev capture`. Every read-only query (`term`, `course`, `grade`, `exam`, etc.) uses Node.js `fetch` against `/jwxt/` JSON endpoints with the cookies saved in `~/.sysu-cli/session.json` (`0600`).
2. **Structured JSON contract**: Every command writes `{ ok: true, command, data }` or `{ ok: false, command, error: { code, message, hint?, details? } }` to stdout and exits with a deterministic code (`0` ok, `2` usage/args, `3` auth, `4` upstream/permission, `5` network, `6` browser).
3. **Strict safety boundary**:
   - Never ask for, accept, or store NetID passwords.
   - Never bypass unified authentication, Geetest slider verification, WeCom QR login, rate limits, or campus-network / VPN access controls.
   - Read-only by default. Do not add course-grabbing, auto-evaluation, or attendance-spoofing features.
   - Never commit `session.json`, browser profiles, or `dev capture` output.

## Repository Layout

- `src/cli.js`: binary entrypoint.
- `src/main.js`: declarative command table (`COMMANDS`) and JSON output envelope.
- `src/lib/`: `jwxt.js` (HTTP + mock client), `cookies.js`, `state.js`, `browser.js`, `args.js`, `errors.js`, `paths.js`.
- `src/modules/`: one file per domain (`auth`, `term`, `course`, `grade`, `exam`, `doctor`, `dev`).
- `src/parsers/`: pure functions that turn raw JWXT payloads into stable JSON shapes.
- `skills/sysu-cli-skill/SKILL.md`: agent operating instructions.
- `tests/`: `node --test` unit and contract tests backed by `SYSU_BACKEND=mock`.

## Verification

Run `npm test` before every commit. All tests must pass offline via `SYSU_BACKEND=mock`.
