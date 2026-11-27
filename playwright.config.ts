/**
 * Shared Playwright settings for the manually run browser suites.
 *
 * The benchmark drives Chromium through the `playwright` library under vitest (see
 * vitest.config.ts), not through the `@playwright/test`
 * runner, so this file holds plain typed options rather than a `defineConfig` call. Nothing here
 * adds a dependency.
 *
 * The evaluator's own launch options live in src/evaluator/browser.ts and are part of the frozen
 * source digests; they are deliberately not imported from here so this file can change without
 * altering a scored component.
 *
 * Install the browser with `npx playwright install --with-deps chromium` (CI) or
 * `npm run browsers:install` (local, outside a sandbox).
 */
import type { BrowserContextOptions, LaunchOptions } from 'playwright';

/** Chromium launch options for the article-preview checks (tests/preview). */
export const previewLaunch: LaunchOptions = { headless: true };

/** Default directory of the built preview, relative to examples/harness-benchmark. */
export const previewDistDefault = '../../.tmp/harness-preview/dist';

/** Browser contexts the preview checks open. Each maps to one accessibility behaviour. */
export const previewContexts = {
  /** Diagram views and step lists must be readable with JavaScript disabled. */
  noScript: { javaScriptEnabled: false },
  /** Play control must disappear under prefers-reduced-motion. */
  reducedMotion: { reducedMotion: 'reduce' },
  /** Control case for the reduced-motion check. */
  motionAllowed: { reducedMotion: 'no-preference' },
  /** Narrow phone viewport: the diagram and charts must fit without horizontal overflow. */
  narrow: { viewport: { width: 375, height: 812 } },
} as const satisfies Record<string, BrowserContextOptions>;
