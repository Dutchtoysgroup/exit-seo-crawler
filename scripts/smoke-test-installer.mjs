#!/usr/bin/env node
/**
 * Installer smoke test. Installs (Windows) or mounts (macOS) a built
 * installer, starts the app in its smoke-test mode against a local page
 * whose only link is added by JavaScript, and checks that the app crawled
 * that link with the Chromium shipped inside the installer.
 *
 *   node scripts/smoke-test-installer.mjs <installer> [--arch x64|arm64]
 *
 * <installer> is a .dmg, a *Setup*.exe, or, for a local check of an
 * unpacked build, a .app bundle or the app's .exe. `--arch` also asserts
 * the CPU architecture the app runs as. Run it on a machine of the
 * installer's own architecture: that is the point of the test.
 *
 * The app side lives in apps/desktop/src/main/smoke-test.ts.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const APP_TIMEOUT_MS = 5 * 60_000;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { arch: { type: 'string' } },
});
if (positionals.length !== 1) {
  console.error('usage: smoke-test-installer.mjs <installer> [--arch x64|arm64]');
  process.exit(2);
}
const installer = resolve(positionals[0]);
if (!existsSync(installer)) {
  console.error(`No such installer: ${installer}`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'exit-seo-crawler-smoke-'));
const cleanups = [() => rmSync(work, { recursive: true, force: true })];

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${res.status ?? res.error}`);
}

/** The single entry of `dir` that `test` accepts. */
function only(dir, test, what) {
  const hits = readdirSync(dir).filter(test);
  if (hits.length !== 1) throw new Error(`expected one ${what} in ${dir}, found: ${hits.join(', ') || 'none'}`);
  return join(dir, hits[0]);
}

function macExecutable(appBundle) {
  return only(join(appBundle, 'Contents', 'MacOS'), () => true, 'executable');
}

/** Path of the app's executable, after installing or mounting if needed. */
async function appExecutable() {
  const name = basename(installer);
  if (name.endsWith('.dmg')) {
    const mount = join(work, 'mount');
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, installer]);
    cleanups.unshift(() => spawnSync('hdiutil', ['detach', mount, '-force'], { stdio: 'inherit' }));
    return macExecutable(only(mount, (e) => e.endsWith('.app'), '.app'));
  }
  if (name.endsWith('.app')) return macExecutable(installer);
  if (/setup.*\.exe$/i.test(name)) {
    // NSIS silent install into a directory of our own. /D must come last.
    const dir = join(work, 'installed');
    run(installer, ['/S', `/D=${dir}`]);
    // The installer can hand off to a child process; wait for the files.
    for (let i = 0; i < 60 && !existsSync(dir); i++) await new Promise((r) => setTimeout(r, 1000));
    return only(dir, (e) => e.endsWith('.exe') && !/^uninstall/i.test(e), 'app .exe');
  }
  if (name.endsWith('.exe')) return installer;
  throw new Error(`don't know how to run ${name}`);
}

/** The page under test: its one link only exists once JavaScript has run. */
function startSite() {
  const requests = [];
  const html = (title, body) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body><h1>${title}</h1>${body}</body></html>`;
  const pages = {
    '/': html(
      'Smoke test',
      // Split so no parser can find the path in the raw HTML.
      `<script>var a = document.createElement('a'); a.href = '/rend' + 'ered';` +
        ` a.textContent = 'Rendered'; document.body.appendChild(a);</script>`,
    ),
    '/rendered': html('Rendered', '<p>Only reachable through JavaScript.</p>'),
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://smoke').pathname;
    requests.push({ path, userAgent: String(req.headers['user-agent'] ?? '') });
    const body = pages[path];
    res.writeHead(body ? 200 : 404, { 'content-type': body ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(body ?? 'not found');
  });
  return new Promise((resolveSite) =>
    server.listen(0, '127.0.0.1', () =>
      resolveSite({ url: `http://127.0.0.1:${server.address().port}/`, requests, server }),
    ),
  );
}

function runApp(exe, env) {
  return new Promise((resolveRun) => {
    const child = spawn(exe, [], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      console.error(`App still running after ${APP_TIMEOUT_MS / 1000} s — killing it.`);
      child.kill('SIGKILL');
    }, APP_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`Could not start the app: ${err.message}`);
      resolveRun(null);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveRun(code);
    });
  });
}

let failed = true;
const site = await startSite();
try {
  const exe = await appExecutable();
  const reportPath = join(work, 'report.json');
  const env = {
    ...process.env,
    EXIT_SEO_CRAWLER_SMOKE_TEST: site.url,
    EXIT_SEO_CRAWLER_SMOKE_REPORT: reportPath,
  };
  // Inherited from a Node-run parent this would turn the app into plain Node.
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`Smoke test: ${exe} → ${site.url}`);
  const code = await runApp(exe, env);
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;

  const rendered = report?.urls.find((u) => new URL(u.url).pathname === '/rendered');
  const checks = [
    ['the app exited with code 0', code === 0, `exit code ${code}`],
    ['the app wrote its report', report !== null, ''],
    ['the app passed its own checks', report?.ok === true, (report?.failures ?? []).join('; ')],
    ['it is the packaged app', report?.packaged === true, ''],
    ["it used the installer's own Chromium", report?.bundledBrowsers === true, report?.browserCache ?? ''],
    ...(values.arch
      ? [[`it runs as ${values.arch}`, report?.arch === values.arch, `runs as ${report?.arch}`]]
      : []),
    [
      'Chromium requested the page',
      site.requests.some((r) => r.path === '/' && r.userAgent.includes('Chrome/')),
      '',
    ],
    ['the JavaScript-only link was crawled (200)', rendered?.status === 200, JSON.stringify(rendered ?? null)],
  ];
  for (const [what, ok, detail] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${what}${!ok && detail ? ` — ${detail}` : ''}`);
  }
  failed = checks.some(([, ok]) => !ok);
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
} finally {
  site.server.close();
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      /* best effort */
    }
  }
}
console.log(failed ? 'Smoke test FAILED' : 'Smoke test passed');
process.exit(failed ? 1 : 0);
