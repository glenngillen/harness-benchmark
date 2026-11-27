/**
 * Chromium-backed UI port. Playwright is loaded lazily so unit tests and API-only tooling never
 * need it. A launch failure is the evaluator's (InfrastructureError); anything that goes wrong on
 * the app's page is the app's (CaseFailure).
 */
import { CaseFailure, InfrastructureError } from './expect.ts';
import type { UiBrowser, UiJobItem, UiPage } from './types.ts';

const ACTION_TIMEOUT_MS = 3_000;
const sel = (testId: string) => `[data-testid="${testId.replace(/["\\]/g, '\\$&')}"]`;

async function app<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new CaseFailure(`UI ${what}: ${(e as Error).message.split('\n')[0]}`);
  }
}

export function createPlaywrightBrowser(): UiBrowser {
  let browser: import('playwright').Browser | undefined;
  return {
    async open(url) {
      try {
        const { chromium } = await import('playwright');
        browser ??= await chromium.launch({ headless: true });
      } catch (e) {
        throw new InfrastructureError(`chromium failed to launch: ${(e as Error).message.split('\n')[0]}`);
      }
      let page: import('playwright').Page;
      try {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        page = await context.newPage();
      } catch (e) {
        throw new InfrastructureError(`chromium could not open a page: ${(e as Error).message.split('\n')[0]}`);
      }
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      await app(`load ${url}`, () => page.goto(url, { waitUntil: 'load', timeout: 5_000 }));
      const ui: UiPage = {
        missingTestIds: (ids) =>
          app('inspect', async () => {
            const missing: string[] = [];
            for (const id of ids) if ((await page.locator(sel(id)).count()) === 0) missing.push(id);
            return missing;
          }),
        attribute: (testId, name) => app(`read ${testId}`, () => page.locator(sel(testId)).first().getAttribute(name)),
        setField: (testId, value) =>
          app(`fill ${testId}`, async () => {
            const loc = page.locator(sel(testId)).first();
            const tag = await loc.evaluate((el) => el.tagName);
            if (tag === 'SELECT') await loc.selectOption(value);
            else await loc.fill(value);
          }),
        click: (testId) => app(`click ${testId}`, () => page.locator(sel(testId)).first().click()),
        text: (testId) => app(`read ${testId}`, async () => ((await page.locator(sel(testId)).first().textContent()) ?? '').trim()),
        jobItems: () =>
          app('read job-list', () =>
            page.$$eval('[data-testid="job-list"] [data-testid="job-item"]', (els): UiJobItem[] =>
              els.map((el) => {
                const part = (id: string) => (el.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').trim();
                return { id: el.getAttribute('data-job-id'), status: part('job-status'), progress: part('job-progress'), result: part('job-result') };
              }),
            ),
          ),
      };
      return ui;
    },
    async close() {
      await browser?.close().catch(() => undefined);
      browser = undefined;
    },
  };
}
