import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CliError } from './errors.js';
import { cliHome } from './paths.js';

const lastRequestByBucket = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * In-process polite pacing between consecutive HTTP requests in a single command.
 */
export async function paceRequest(bucket = 'default', minIntervalMs = 350) {
  if (process.env.SYSU_BACKEND === 'mock') return;
  const now = Date.now();
  const prev = lastRequestByBucket.get(bucket) ?? 0;
  const waitMs = minIntervalMs - (now - prev);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastRequestByBucket.set(bucket, Date.now());
}

/**
 * Cross-process cooldown guard persisted in ~/.sysu-cli/rate-limit.json
 * to prevent scripts or AI agents from invoking sensitive actions (like gym booking)
 * in high-frequency loops.
 */
export async function enforceActionCooldown(actionKey, cooldownMs = 3000) {
  if (process.env.SYSU_BACKEND === 'mock' && process.env.SYSU_FORCE_RATE_LIMIT !== '1') return;
  const file = join(cliHome(), 'rate-limit.json');
  let state = {};
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    state = {};
  }

  const now = Date.now();
  const lastAt = Number(state[actionKey] ?? 0);
  const elapsed = now - lastAt;
  if (lastAt > 0 && elapsed < cooldownMs) {
    const retryAfterMs = cooldownMs - elapsed;
    throw new CliError(
      'RATE_LIMITED',
      `Action "${actionKey}" was called too frequently (${elapsed}ms since last call; minimum interval is ${cooldownMs}ms).`,
      {
        hint: `Wait at least ${Math.ceil(retryAfterMs / 1000)}s before retrying. High-frequency polling or burst requests are prohibited.`,
        details: { action: actionKey, cooldownMs, retryAfterMs }
      }
    );
  }

  state[actionKey] = now;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
