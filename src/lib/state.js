import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { statePath } from './paths.js';

/**
 * Session state is a Playwright-compatible storageState subset:
 * { version, savedAt, browser, cookies: [...], origins: [] }.
 * It contains live session cookies and must stay local (mode 0600).
 */
export async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'));
    if (!parsed || !Array.isArray(parsed.cookies)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveState(state) {
  const file = statePath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = {
    version: 1,
    ...state,
    updatedAt: new Date().toISOString()
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
  return file;
}

export async function deleteState() {
  await rm(statePath(), { force: true });
}
