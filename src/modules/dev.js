import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { launchProfile } from '../lib/browser.js';
import { CliError } from '../lib/errors.js';
import { JWXT_BASE } from '../lib/jwxt.js';
import { capturesDir } from '../lib/paths.js';

const MAX_ENTRIES = 400;
const MAX_BODY_CHARS = 200_000;

/**
 * Developer helper: open the logged-in profile on a JWXT page, let the user
 * click around normally, and record JSON XHR traffic under /jwxt/ to a local
 * file. Used to map new endpoints. Output is sensitive; never commit it.
 */
export async function capture({ url, browser } = {}) {
  if (process.env.SYSU_BACKEND === 'mock') {
    throw new CliError('BACKEND_UNAVAILABLE', '`dev capture` needs a real browser and is unavailable in mock mode.');
  }
  const startUrl = url ?? `${JWXT_BASE}/#/student`;
  const launched = await launchProfile({ browser, headless: false });
  const { context } = launched;
  const entries = [];

  context.on('response', async (response) => {
    if (entries.length >= MAX_ENTRIES) return;
    const responseUrl = response.url();
    if (!responseUrl.includes('/jwxt/') || /\.(js|css|png|jpg|svg|woff2?|ico)(\?|$)/i.test(responseUrl)) return;
    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('json')) return;
    const request = response.request();
    let body = null;
    try {
      const text = await response.text();
      body = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…[truncated]` : JSON.parse(text);
    } catch {
      body = null;
    }
    entries.push({
      at: new Date().toISOString(),
      method: request.method(),
      url: redactUrl(responseUrl),
      status: response.status(),
      menuid: request.headers().menuid ?? null,
      postData: request.postData() ?? null,
      body
    });
  });

  process.stderr.write(`Capturing JSON traffic from ${startUrl}. Navigate to the pages you want, then close the browser window.\n`);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise((resolve) => context.once('close', resolve));
  } finally {
    await context.close().catch(() => {});
  }

  await mkdir(capturesDir(), { recursive: true });
  const file = join(capturesDir(), `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify({ startUrl, entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    file,
    count: entries.length,
    endpoints: [...new Set(entries.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`))],
    warning: 'Capture files contain personal data. Redact before sharing; never commit them.'
  };
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('_t');
    for (const key of ['ticket', 'token', 'code']) {
      if (parsed.searchParams.has(key) && key !== 'code') parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
