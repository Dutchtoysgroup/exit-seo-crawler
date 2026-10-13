/**
 * Runs the real crawler (the same `Crawler` + `ProjectDb` the CLI uses)
 * into a throwaway project file and reads back what it stored.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from '@freecrawl/core';
import { ProjectDb } from '@freecrawl/db';

export interface UrlRow {
  url: string;
  status_code: number | null;
  indexability: string;
  indexability_reason: string | null;
  canonical: string | null;
  canonical_http: string | null;
  canonical_final_url: string | null;
  redirect_target: string | null;
  redirect_chain_length: number;
  redirect_final_url: string | null;
  redirect_loop: number;
}

export interface CrawlLog {
  errors: string[];
  warnings: string[];
}

/** Polls `condition` every 10 ms until it holds; throws after `timeoutMs`. */
export async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Small, sequential-ish defaults so a fixture crawl is fast and repeatable. */
export function fixtureConfig(startUrl: string, overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    ...DEFAULT_CRAWL_CONFIG,
    startUrl,
    maxConcurrency: 2,
    maxRps: 0,
    retryAttempts: 0,
    discoverSitemaps: false,
    ...overrides,
  };
}

export class TestProject {
  readonly dir = mkdtempSync(join(tmpdir(), 'exit-seo-crawler-test-'));
  readonly path = join(this.dir, 'test.seoproject');
  readonly db = new ProjectDb(this.path);

  /** A crawler on this project that records its errors and warnings. */
  crawler(
    config: CrawlConfig,
    opts: ConstructorParameters<typeof Crawler>[2] = {},
  ): { crawler: Crawler; log: CrawlLog } {
    const crawler = new Crawler(config, this.db, opts);
    const log: CrawlLog = { errors: [], warnings: [] };
    crawler.on('error', (m) => log.errors.push(m));
    crawler.on('warn', (m) => log.warnings.push(m));
    return { crawler, log };
  }

  /** Crawls to completion and returns the log. */
  async crawl(config: CrawlConfig): Promise<CrawlLog> {
    const { crawler, log } = this.crawler(config);
    await crawler.start();
    return log;
  }

  /**
   * Every stored URL row, sorted by URL. With `origin`, that prefix is cut
   * from every value, so expectations don't depend on the server's port.
   */
  rows(origin?: string): UrlRow[] {
    const rows = this.query<UrlRow>(
      `SELECT url, status_code, indexability, indexability_reason, canonical,
              canonical_http, canonical_final_url, redirect_target, redirect_chain_length,
              redirect_final_url, redirect_loop
         FROM urls ORDER BY url`,
    );
    if (!origin) return rows;
    return rows.map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v.replaceAll(origin, '') : v]),
        ) as unknown as UrlRow,
    );
  }

  query<T>(sql: string): T[] {
    // A second connection, so the test reads what reached the file.
    const raw = new DatabaseSync(this.path, { readOnly: true });
    try {
      return raw.prepare(sql).all() as T[];
    } finally {
      raw.close();
    }
  }

  dispose(): void {
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
