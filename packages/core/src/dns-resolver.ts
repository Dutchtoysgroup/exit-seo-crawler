import dns from 'node:dns';
import net from 'node:net';
import type { LookupOptions } from 'node:dns';

/**
 * Cached DNS resolver that uses ONLY the operating system's resolver.
 *
 * Dutch Toys Group fork: upstream escalated failed lookups to hard-coded
 * public DNS servers (UDP/53 to 1.1.1.1, 1.0.0.1, 8.8.8.8, 9.9.9.9) and
 * then to DNS-over-HTTPS on raw IP literals. Those direct connections to
 * IP addresses tripped firewall / sandbox prompts asking the user to
 * approve each IP before certain sites could be crawled. Lookups now go
 * through the OS resolver only — the same path every other app on the
 * machine uses — so `/etc/hosts`, VPN split-DNS and corporate internal
 * zones keep working, and a failed lookup simply fails.
 *
 * Successful results are cached for 5 min; failures for 15 s so tight
 * retry loops don't hammer the system resolver.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const ERROR_CACHE_TTL_MS = 15 * 1000;

const OS_LOOKUP_TIMEOUT_MS = 4_000;

export type DnsTier = 'os';

export interface DnsResolverEvent {
  hostname: string;
  tier: DnsTier;
  outcome: 'success' | 'failure';
  /** ms from lookup start */
  durationMs: number;
  /** Detail set when outcome === 'failure' */
  error?: string;
}

export type DnsResolverHook = (event: DnsResolverEvent) => void;

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface CacheEntry {
  addresses: ResolvedAddress[];
  expires: number;
  /** Whether this is a negative-cache entry (no resolution found) */
  negative?: boolean;
}

const cache = new Map<string, CacheEntry>();

/**
 * For unit tests / explicit cache invalidation. Not exported on the
 * package barrel — internal only.
 */
export function _clearDnsCacheForTests(): void {
  cache.clear();
}

// Hot-swappable global hook. The lookup function is installed into
// undici exactly once per process (in initHttpClient), but each new
// Crawler instance wants to receive its own DNS diagnostics.
// This module-level mutable hook lets a Crawler register its emitter
// for the duration of its run without rebuilding the dispatcher.
let activeHook: DnsResolverHook | null = null;
export function setActiveDnsHook(hook: DnsResolverHook | null): void {
  activeHook = hook;
}

function isLiteralIp(host: string): { address: string; family: 4 | 6 } | null {
  if (net.isIPv4(host)) return { address: host, family: 4 };
  if (net.isIPv6(host)) return { address: host, family: 6 };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// OS resolver
// ─────────────────────────────────────────────────────────────────────────────

function osLookup(hostname: string): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const to = setTimeout(() => {
      if (settled) return;
      settled = true;
      const e: NodeJS.ErrnoException = new Error('OS DNS lookup timeout');
      e.code = 'ETIMEDOUT';
      reject(e);
    }, OS_LOOKUP_TIMEOUT_MS);
    dns.lookup(
      hostname,
      { all: true, family: 0, verbatim: true },
      (err, addresses) => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        if (err) {
          reject(err);
          return;
        }
        const out: ResolvedAddress[] = [];
        for (const a of addresses) {
          if (a.family === 4 || a.family === 6) {
            out.push({ address: a.address, family: a.family });
          }
        }
        resolve(out);
      },
    );
  });
}

async function resolveHost(
  hostname: string,
  hook: DnsResolverHook | undefined,
): Promise<ResolvedAddress[]> {
  const t0 = Date.now();
  try {
    const r = await osLookup(hostname);
    if (r.length === 0) {
      const e: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      e.code = 'ENOTFOUND';
      throw e;
    }
    hook?.({
      hostname,
      tier: 'os',
      outcome: 'success',
      durationMs: Date.now() - t0,
    });
    return r;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    hook?.({
      hostname,
      tier: 'os',
      outcome: 'failure',
      durationMs: Date.now() - t0,
      error: `${e.code ?? 'Error'} ${e.message ?? ''}`.trim(),
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public lookup factory — Node `dns.lookup`-shaped API for undici
// ─────────────────────────────────────────────────────────────────────────────

interface LookupCallback {
  (err: NodeJS.ErrnoException | null, address?: string, family?: number): void;
  (
    err: NodeJS.ErrnoException | null,
    addresses?: { address: string; family: number }[],
  ): void;
}

type NodeLookup = (
  hostname: string,
  optionsOrCb: LookupOptions | number | LookupCallback | undefined,
  maybeCb?: LookupCallback,
) => void;

export interface ResilientLookupOptions {
  /** Subscribe to per-lookup resolution events for logging/diagnostics. */
  onEvent?: DnsResolverHook;
}

export function createResilientLookup(opts: ResilientLookupOptions = {}): NodeLookup {
  const installedHook = opts.onEvent;
  // Compose: dispatch every lookup event to BOTH the install-time hook
  // (set when initHttpClient ran — typically the desktop main-process
  // logger) and the active per-crawl hook (registered by Crawler.start
  // so the event surfaces inside the in-app log window with crawl
  // context attached).
  const hook: DnsResolverHook = (event) => {
    try {
      installedHook?.(event);
    } catch {
      /* hook must never break the resolve */
    }
    try {
      activeHook?.(event);
    } catch {
      /* same */
    }
  };
  return function lookup(
    hostname: string,
    optionsOrCb: LookupOptions | number | LookupCallback | undefined,
    maybeCb?: LookupCallback,
  ): void {
    let options: LookupOptions = {};
    let cb: LookupCallback;
    if (typeof optionsOrCb === 'function') {
      cb = optionsOrCb;
    } else if (typeof optionsOrCb === 'number') {
      options = { family: optionsOrCb as 0 | 4 | 6 };
      cb = maybeCb as LookupCallback;
    } else {
      options = (optionsOrCb ?? {}) as LookupOptions;
      cb = maybeCb as LookupCallback;
    }

    // Pass-through for IP literals — undici does this itself but being
    // defensive avoids a redundant round-trip if our lookup is invoked
    // on something already resolved.
    const literal = isLiteralIp(hostname);
    if (literal) {
      deliver([literal], options, cb);
      return;
    }

    const now = Date.now();
    const cached = cache.get(hostname);
    if (cached && cached.expires > now) {
      if (cached.negative || cached.addresses.length === 0) {
        const err: NodeJS.ErrnoException = new Error(
          `getaddrinfo ENOTFOUND ${hostname}`,
        );
        err.code = 'ENOTFOUND';
        cb(err);
        return;
      }
      deliver(cached.addresses, options, cb);
      return;
    }

    resolveHost(hostname, hook)
      .then((addresses) => {
        cache.set(hostname, {
          addresses,
          expires: Date.now() + CACHE_TTL_MS,
        });
        deliver(addresses, options, cb);
      })
      .catch((err: NodeJS.ErrnoException) => {
        cache.set(hostname, {
          addresses: [],
          expires: Date.now() + ERROR_CACHE_TTL_MS,
          negative: true,
        });
        cb(err);
      });
  };
}

function deliver(
  addresses: ResolvedAddress[],
  options: LookupOptions,
  cb: LookupCallback,
): void {
  const family = options.family ?? 0;
  const filtered =
    family === 0 ? addresses : addresses.filter((a) => a.family === family);
  if (filtered.length === 0) {
    const err: NodeJS.ErrnoException = new Error('getaddrinfo ENOTFOUND');
    err.code = 'ENOTFOUND';
    cb(err);
    return;
  }
  if (options.all) {
    cb(
      null,
      filtered.map((a) => ({ address: a.address, family: a.family })),
    );
  } else {
    const first = filtered[0]!;
    (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
      null,
      first.address,
      first.family,
    );
  }
}
