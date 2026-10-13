/**
 * Regression tests for the core crawler against a local fixture website.
 *
 * Each site below is fully declared, so every crawl of it has exactly one
 * correct outcome. The tests pin that outcome: status, indexability,
 * redirect chain and canonical per URL, which URLs robots.txt keeps off the
 * wire, and that pausing, or resuming an interrupted crawl, ends in the
 * same result as an uninterrupted one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  links,
  page,
  redirect,
  startFixtureSite,
  type FixtureRoute,
  type FixtureSite,
} from './support/fixture-site.js';
import { TestProject, fixtureConfig, waitUntil, type UrlRow } from './support/crawl.js';

/** The row an ordinary indexable 200 page gets; `over` sets the rest. */
function row(url: string, over: Partial<UrlRow> = {}): UrlRow {
  return {
    url,
    status_code: 200,
    indexability: 'indexable',
    indexability_reason: null,
    canonical: null,
    canonical_http: null,
    canonical_final_url: null,
    redirect_target: null,
    redirect_chain_length: 0,
    redirect_final_url: null,
    redirect_loop: 0,
    ...over,
  };
}

function redirectRow(
  url: string,
  status: number,
  target: string,
  chain: { length: number; finalUrl: string | null; loop?: boolean },
): UrlRow {
  return row(url, {
    status_code: status,
    indexability: 'non-indexable:redirect',
    indexability_reason: `Redirects to ${target}`,
    redirect_target: target,
    redirect_chain_length: chain.length,
    redirect_final_url: chain.finalUrl,
    redirect_loop: chain.loop ? 1 : 0,
  });
}

const robotsBlocked = (url: string): UrlRow =>
  row(url, {
    status_code: null,
    indexability: 'non-indexable:robots-blocked',
    indexability_reason: 'Blocked by robots.txt',
  });

const ROBOTS_TXT: FixtureRoute = {
  headers: { 'content-type': 'text/plain' },
  body: 'User-agent: *\nDisallow: /private/\n',
};

describe('redirects, canonicals and indexability', () => {
  let site: FixtureSite;
  beforeAll(async () => {
    site = await startFixtureSite({
      '/robots.txt': ROBOTS_TXT,
      '/': page({
        title: 'Home',
        body: links(
          '/about',
          '/old',
          '/temp',
          '/chain-1',
          '/loop-a',
          '/duplicate',
          '/header-canonical',
          '/noindex',
          '/x-robots-noindex',
          '/private/report',
          '/missing',
        ),
      }),
      '/about': page({ title: 'About', head: '<link rel="canonical" href="/about">' }),
      '/contact': page({ title: 'Contact' }),
      '/old': redirect(301, '/about'),
      '/temp': redirect(302, '/contact'),
      '/chain-1': redirect(301, '/chain-2'),
      '/chain-2': redirect(308, '/contact'),
      '/loop-a': redirect(301, '/loop-b'),
      '/loop-b': redirect(301, '/loop-a'),
      '/duplicate': page({ title: 'Duplicate', head: '<link rel="canonical" href="/about">' }),
      '/header-canonical': {
        ...page({ title: 'Header canonical' }),
        headers: {
          'content-type': 'text/html; charset=utf-8',
          link: '</about>; rel="canonical"',
        },
      },
      '/noindex': page({ title: 'Noindex', head: '<meta name="robots" content="noindex">' }),
      '/x-robots-noindex': {
        ...page({ title: 'X-Robots-Tag' }),
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
      },
      '/private/report': page({ title: 'Private' }),
    });
  });
  afterAll(() => site.close());

  const expected = (): UrlRow[] => [
    row('/'),
    row('/about', { canonical: '/about' }),
    redirectRow('/chain-1', 301, '/chain-2', { length: 2, finalUrl: '/contact' }),
    redirectRow('/chain-2', 308, '/contact', { length: 1, finalUrl: '/contact' }),
    row('/contact'),
    row('/duplicate', {
      indexability: 'non-indexable:canonical',
      indexability_reason: 'canonical points to /about',
      canonical: '/about',
      canonical_final_url: '/about',
    }),
    row('/header-canonical', {
      indexability: 'non-indexable:canonical',
      indexability_reason: 'HTTP canonical points to /about',
      canonical_http: '/about',
    }),
    redirectRow('/loop-a', 301, '/loop-b', { length: 2, finalUrl: null, loop: true }),
    redirectRow('/loop-b', 301, '/loop-a', { length: 2, finalUrl: null, loop: true }),
    row('/missing', {
      status_code: 404,
      indexability: 'non-indexable:client-error',
      indexability_reason: 'HTTP 404',
    }),
    row('/noindex', {
      indexability: 'non-indexable:noindex',
      indexability_reason: 'meta robots: noindex',
    }),
    redirectRow('/old', 301, '/about', { length: 1, finalUrl: '/about' }),
    robotsBlocked('/private/report'),
    redirectRow('/temp', 302, '/contact', { length: 1, finalUrl: '/contact' }),
    row('/x-robots-noindex', {
      indexability: 'non-indexable:noindex',
      indexability_reason: 'X-Robots-Tag: noindex',
    }),
  ];

  // The same answer whether pages are fetched one at a time or many at
  // once: nothing here may depend on the order responses arrive in.
  test.each([1, 8])('a crawl at concurrency %i stores the known result', async (maxConcurrency) => {
    const project = new TestProject();
    try {
      const log = await project.crawl(fixtureConfig(site.url('/'), { maxConcurrency }));
      expect(log.errors).toEqual([]);
      expect(project.rows(site.origin)).toEqual(expected());
    } finally {
      project.dispose();
    }
  });
});

describe('robots.txt', () => {
  const routes = (robots: FixtureRoute): Record<string, FixtureRoute> => ({
    '/robots.txt': robots,
    '/': page({ title: 'Home', body: links('/a', '/private/one') }),
    '/a': page({ title: 'A', body: links('/private/two') }),
    '/private/one': page({ title: 'One' }),
    '/private/two': page({ title: 'Two' }),
  });

  // A robots.txt slower than the pages used to lose the race: the first
  // pages' disallowed links were fetched and stored as indexable.
  test.each([0, 1000])(
    'disallowed URLs are recorded, never requested (robots.txt answers after %i ms)',
    async (delayMs) => {
      const site = await startFixtureSite(routes({ ...ROBOTS_TXT, delayMs }));
      const project = new TestProject();
      try {
        await project.crawl(fixtureConfig(site.url('/')));
        expect(project.rows(site.origin)).toEqual([
          row('/'),
          row('/a'),
          robotsBlocked('/private/one'),
          robotsBlocked('/private/two'),
        ]);
        expect(site.hits('/private/one')).toBe(0);
        expect(site.hits('/private/two')).toBe(0);
        expect(site.hits('/robots.txt')).toBe(1);
      } finally {
        project.dispose();
        await site.close();
      }
    },
  );

  test('with robots.txt ignored, the disallowed pages are crawled', async () => {
    const site = await startFixtureSite(routes(ROBOTS_TXT));
    const project = new TestProject();
    try {
      await project.crawl(fixtureConfig(site.url('/'), { respectRobotsTxt: false }));
      expect(project.rows(site.origin)).toEqual([
        row('/'),
        row('/a'),
        row('/private/one'),
        row('/private/two'),
      ]);
      expect(site.hits('/robots.txt')).toBe(0);
    } finally {
      project.dispose();
      await site.close();
    }
  });

  test('a start URL robots.txt disallows is recorded as blocked and not crawled', async () => {
    const site = await startFixtureSite(
      routes({ headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' }),
    );
    const project = new TestProject();
    try {
      await project.crawl(fixtureConfig(site.url('/')));
      expect(project.rows(site.origin)).toEqual([robotsBlocked('/')]);
      expect(site.hits('/a')).toBe(0);
    } finally {
      project.dispose();
      await site.close();
    }
  });
});

describe('pause and resume', () => {
  /** A home page linking 40 slow pages — a crawl that takes about a second. */
  const PAGES = Array.from({ length: 40 }, (_, i) => `/p/${i + 1}`);
  const slowSite = (): Promise<FixtureSite> =>
    startFixtureSite({
      '/': page({ title: 'Home', body: links(...PAGES) }),
      ...Object.fromEntries(PAGES.map((p) => [p, { ...page({ title: p }), delayMs: 50 }])),
    });
  const pageRequests = (site: FixtureSite): string[] =>
    site.requests.filter((r) => r.path.startsWith('/p/')).map((r) => r.path);
  const complete = (): UrlRow[] => [row('/'), ...PAGES.map((p) => row(p))].sort((a, b) => a.url.localeCompare(b.url));

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a paused crawl sends no requests and finishes the same after resume', async () => {
    const site = await slowSite();
    const project = new TestProject();
    try {
      const { crawler, log } = project.crawler(fixtureConfig(site.url('/')));
      const done = crawler.start();
      await waitUntil(() => pageRequests(site).length >= 6);
      crawler.pause();
      const requestsAtPause = site.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(site.requests.length).toBe(requestsAtPause);

      crawler.resume();
      await done;
      expect(log.errors).toEqual([]);
      expect(project.rows(site.origin)).toEqual(complete());
    } finally {
      project.dispose();
      await site.close();
    }
  });

  // The desktop app's crash recovery: the crawler checkpoints its queue
  // every 30 s, and after a crash the next launch starts a `resumeOnly`
  // crawler on that checkpoint. Only the 30 s timer is faked, so the
  // checkpoint is written by the real code path.
  test('an interrupted crawl resumes from its checkpoint without refetching finished pages', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const site = await slowSite();
    const project = new TestProject();
    try {
      const config = fixtureConfig(site.url('/'));
      const first = project.crawler(config);
      const firstDone = first.crawler.start();
      await waitUntil(() => pageRequests(site).length >= 8);
      // Freeze the queue, let the checkpoint timer fire, then pull the plug.
      first.crawler.pause();
      await vi.advanceTimersByTimeAsync(30_000);
      first.crawler.stop();
      await firstDone;
      vi.useRealTimers();

      const checkpoint = project.db.loadQueueCheckpoint();
      const finished = project.rows(site.origin).filter((r) => r.status_code === 200).map((r) => r.url);
      expect(checkpoint.length).toBeGreaterThan(0);
      expect(finished.length).toBeGreaterThan(1);
      expect(finished.length).toBeLessThan(PAGES.length + 1);

      const requestsBeforeResume = site.requests.length;
      const second = project.crawler(
        { ...config, startUrl: checkpoint[0]!.seedUrl },
        { resumeOnly: true },
      );
      second.crawler.enqueueCheckpointed(checkpoint.map(({ url, depth }) => ({ url, depth })));
      await second.crawler.start();

      const resumedPageRequests = site.requests
        .slice(requestsBeforeResume)
        .map((r) => r.path)
        .filter((p) => p.startsWith('/p/'));
      expect(resumedPageRequests.filter((p) => finished.includes(p))).toEqual([]);
      expect(second.log.errors).toEqual([]);
      expect(project.rows(site.origin)).toEqual(complete());
      expect(project.db.loadQueueCheckpoint()).toEqual([]);
    } finally {
      project.dispose();
      await site.close();
    }
  });

  test('a crawl that finishes leaves nothing to resume', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const site = await slowSite();
    const project = new TestProject();
    try {
      const { crawler } = project.crawler(fixtureConfig(site.url('/')));
      const done = crawler.start();
      await waitUntil(() => pageRequests(site).length >= 8);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(project.db.loadQueueCheckpoint().length).toBeGreaterThan(0);
      await done;
      expect(project.db.loadQueueCheckpoint()).toEqual([]);
    } finally {
      project.dispose();
      await site.close();
    }
  });
});
