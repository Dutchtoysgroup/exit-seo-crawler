/**
 * Installer smoke test: the packaged app crawls one local page with
 * JavaScript rendering, using the Chromium shipped inside the installer,
 * writes a report and exits. No window, no prompts, no downloads.
 *
 * The release workflow installs every installer on a runner of its own
 * architecture and runs this (scripts/smoke-test-installer.mjs), because a
 * successful build has shipped a browser for the wrong CPU before: the
 * Intel .dmg once carried the arm64 Chromium and every Intel user hit the
 * "browser missing" dialog.
 *
 * Started by EXIT_SEO_CRAWLER_SMOKE_TEST=<loopback URL>. The JSON report
 * goes to the file in EXIT_SEO_CRAWLER_SMOKE_REPORT (and to stdout). Exit
 * code 0 means: bundled browsers in use, the crawl ran without errors and
 * every page was rendered by Chromium.
 */
import { app } from 'electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { BrowserPool, Crawler, renderUrl } from '@freecrawl/core';
import { ProjectDb } from '@freecrawl/db';
import { usingBundledBrowsers } from './playwright-setup.js';

const SMOKE_URL = process.env.EXIT_SEO_CRAWLER_SMOKE_TEST ?? '';

export function isSmokeTest(): boolean {
  return SMOKE_URL !== '';
}

interface SmokeReport {
  ok: boolean;
  failures: string[];
  appVersion: string;
  platform: string;
  arch: string;
  packaged: boolean;
  browserCache: string;
  bundledBrowsers: boolean;
  renders: { ok: number; failed: number };
  urls: { url: string; status: number | null; title: string | null }[];
  errors: string[];
}

/** Runs the smoke test and resolves to the process exit code. */
export async function runSmokeTest(browserCacheDecision: string): Promise<number> {
  const report: SmokeReport = {
    ok: false,
    failures: [],
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    browserCache: browserCacheDecision,
    bundledBrowsers: usingBundledBrowsers(),
    renders: { ok: 0, failed: 0 },
    urls: [],
    errors: [],
  };
  const fail = (msg: string): void => {
    report.failures.push(msg);
  };

  const dir = mkdtempSync(join(tmpdir(), 'exit-seo-crawler-smoke-'));
  let pool: BrowserPool | null = null;
  let db: ProjectDb | null = null;
  try {
    // A self-test, not a headless crawler: it only ever crawls this machine.
    const host = new URL(SMOKE_URL).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      throw new Error(`smoke test URL must be on this machine, got ${host}`);
    }
    if (app.isPackaged && !report.bundledBrowsers) {
      throw new Error(`the installer's own Chromium is not in use: ${browserCacheDecision}`);
    }

    const config: CrawlConfig = {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: SMOKE_URL,
      renderingMode: 'js',
      maxUrls: 50,
      maxDepth: 3,
      maxConcurrency: 2,
      discoverSitemaps: false,
    };
    pool = new BrowserPool({
      maxPages: 2,
      headless: true,
      viewport: { width: config.jsRender.viewportWidth, height: config.jsRender.viewportHeight },
    });
    // Throws when Chromium is missing or can't start; the app would offer a
    // download here, the smoke test fails instead.
    await pool.start();
    const browser = pool;

    db = new ProjectDb(join(dir, 'smoke.seoproject'));
    const crawler = new Crawler(config, db, {
      renderUrl: async (url, _urlId, signal) => {
        const res = await renderUrl(
          url,
          browser,
          {
            timeoutMs: 30_000,
            ajaxTimeoutMs: config.jsRender.ajaxTimeoutMs,
            waitUntil: config.jsRender.waitUntil,
          },
          signal,
        );
        if (res.ok) report.renders.ok++;
        else {
          report.renders.failed++;
          report.errors.push(`render failed for ${url}: ${res.error ?? 'unknown error'}`);
        }
        return { ok: res.ok, html: res.html, timingMs: res.timingMs, error: res.error };
      },
    });
    crawler.on('error', (msg) => report.errors.push(msg));
    await crawler.start();

    for (const url of db.getAllUrls().sort()) {
      const id = db.getUrlIdByUrl(url);
      const row = id === null ? null : db.getUrlById(id);
      report.urls.push({ url, status: row?.statusCode ?? null, title: row?.title ?? null });
    }

    if (report.errors.length > 0) fail('the crawl reported errors');
    if (report.renders.ok === 0) fail('Chromium rendered no page');
    if (report.renders.failed > 0) fail('Chromium failed to render a page');
    if (report.urls.length === 0) fail('nothing was crawled');
    if (report.urls.some((u) => u.status !== 200)) fail('a page did not return 200');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    await pool?.close().catch(() => undefined);
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }

  report.ok = report.failures.length === 0;
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  const reportPath = process.env.EXIT_SEO_CRAWLER_SMOKE_REPORT;
  if (reportPath) writeFileSync(reportPath, json);
  return report.ok ? 0 : 1;
}
