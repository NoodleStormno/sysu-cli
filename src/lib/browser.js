import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CliError } from './errors.js';
import { profilesDir } from './paths.js';

const CANDIDATES = {
  chrome: { id: 'chrome', label: 'Google Chrome', channel: 'chrome' },
  edge: { id: 'edge', label: 'Microsoft Edge', channel: 'msedge' },
  chromium: { id: 'chromium', label: 'Playwright Chromium', channel: undefined }
};

export function normalizeBrowser(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (['msedge', 'microsoft-edge'].includes(normalized)) return 'edge';
  if (['google-chrome'].includes(normalized)) return 'chrome';
  if (Object.hasOwn(CANDIDATES, normalized)) return normalized;
  throw new CliError('INVALID_ARGUMENT', `Unsupported browser "${value}". Use chrome, edge or chromium.`);
}

export async function importPlaywright() {
  try {
    return await import('playwright');
  } catch (cause) {
    throw new CliError('BACKEND_UNAVAILABLE', 'Playwright is not installed.', {
      hint: 'Reinstall sysu-cli (`npm install --global sysu-cli`) so its playwright dependency is present.',
      cause
    });
  }
}

/**
 * Launch a persistent browser profile dedicated to sysu-cli.
 * Order: explicit option -> SYSU_BROWSER -> chrome -> edge -> bundled chromium.
 */
export async function launchProfile({ browser, headless = false } = {}) {
  const { chromium } = await importPlaywright();
  const explicit = normalizeBrowser(browser) ?? normalizeBrowser(process.env.SYSU_BROWSER);
  const order = explicit ? [explicit] : ['chrome', 'edge', 'chromium'];
  const failures = [];

  for (const id of order) {
    const candidate = CANDIDATES[id];
    const userDataDir = join(profilesDir(), id);
    await mkdir(userDataDir, { recursive: true });
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        ...(candidate.channel ? { channel: candidate.channel } : {}),
        headless
      });
      if (!headless) {
        const page = context.pages()[0] ?? await context.newPage();
        await page.bringToFront().catch(() => {});
      }
      return { context, browser: candidate, userDataDir };
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/ProcessSingleton|already in use|user data directory is already/i.test(message)) {
        throw new CliError('BROWSER_BUSY', `The sysu-cli ${candidate.label} profile is already open.`, {
          hint: 'Close the other sysu-cli browser window (or wait for the previous command to finish), then retry.'
        });
      }
      failures.push({ browser: id, error: message.split('\n')[0] });
    }
  }

  throw new CliError('BROWSER_UNAVAILABLE', 'No usable browser was found for sysu-cli login.', {
    hint: 'Install Google Chrome or Microsoft Edge, or run `npx playwright install chromium` and retry with `--browser chromium`.',
    details: { tried: failures }
  });
}
