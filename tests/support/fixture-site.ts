/**
 * A tiny website on 127.0.0.1 for crawler regression tests.
 *
 * Every page is declared up front, so a crawl of it has one right answer:
 * the tests compare what the crawler recorded against that answer instead
 * of against whatever the internet served that day. Unknown paths are 404.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Hold the response this long — gives pause/stop tests a window. */
  delayMs?: number;
}

export interface FixtureRequest {
  method: string;
  path: string;
  userAgent: string;
}

export interface FixtureSite {
  /** `http://127.0.0.1:<port>` — no trailing slash. */
  origin: string;
  url(path: string): string;
  /** Every request served, in arrival order. */
  requests: FixtureRequest[];
  /** How often `path` was requested with GET. */
  hits(path: string): number;
  close(): Promise<void>;
}

/** An HTML page with the given head and body markup. */
export function page(opts: { title: string; head?: string; body?: string }): FixtureRoute {
  return {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body:
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<title>${opts.title}</title>${opts.head ?? ''}</head>` +
      `<body><h1>${opts.title}</h1>${opts.body ?? ''}</body></html>`,
  };
}

export function redirect(status: 301 | 302 | 307 | 308, location: string): FixtureRoute {
  return { status, headers: { location } };
}

export function links(...paths: string[]): string {
  return paths.map((p) => `<a href="${p}">${p}</a>`).join(' ');
}

export async function startFixtureSite(
  routes: Record<string, FixtureRoute>,
): Promise<FixtureSite> {
  const requests: FixtureRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    requests.push({
      method: req.method ?? 'GET',
      path,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
    const route = routes[path];
    const respond = (): void => {
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(route.status ?? 200, route.headers ?? {});
      res.end(req.method === 'HEAD' ? undefined : (route.body ?? ''));
    };
    if (route?.delayMs) setTimeout(respond, route.delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    requests,
    hits: (path) => requests.filter((r) => r.method === 'GET' && r.path === path).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
