#!/usr/bin/env node
/**
 * Builds the CLI as one self-contained executable (Node "single executable
 * application"), so colleagues can run it without installing Node.
 *
 *   node apps/cli/scripts/build-sea.mjs --target darwin-arm64 [--node <path>]
 *
 * Targets: darwin-arm64, darwin-x64, win-x64. `--node` is the Node binary to
 * inject into — it must be the same Node version as the one running this
 * script (the SEA blob is version-bound; code cache is off, so the CPU
 * architecture may differ). Defaults to the running Node, i.e. a native build.
 *
 * Steps: run `npm run build:cli` first (tsc output in apps/cli/dist).
 *   1. esbuild bundles dist/index.js + workspace packages into one CJS file.
 *      Playwright stays out: JS rendering is a desktop-app feature, and the
 *      dynamic import fails with a clear error if a config turns it on.
 *   2. node --experimental-sea-config writes the blob.
 *   3. postject injects it into a copy of the Node binary (macOS: signature
 *      removed first, then Developer ID-signed and notarized when
 *      MAC_CODESIGN_IDENTITY and the APPLE_API_* variables are set, ad-hoc
 *      signed otherwise — arm64 refuses unsigned).
 *   4. The result is packed: .tar.gz on macOS, .zip on Windows, in apps/cli/release.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const repoRoot = resolve(cliRoot, '../..');

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    node: { type: 'string' },
  },
});

const TARGETS = {
  'darwin-arm64': { os: 'mac', label: 'macOS-Apple-Silicon', exe: 'exit-seo-crawler' },
  'darwin-x64': { os: 'mac', label: 'macOS-Intel', exe: 'exit-seo-crawler' },
  'win-x64': { os: 'win', label: 'Windows', exe: 'exit-seo-crawler.exe' },
};
const target = TARGETS[values.target ?? ''];
if (!target) {
  console.error(`--target must be one of: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(2);
}

const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const work = join(cliRoot, 'sea', values.target);
const out = join(cliRoot, 'release');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// 1. Bundle. The banner hides Node's ExperimentalWarnings (SQLite, SEA) —
// noise for someone who just wants a crawl.
const bundle = join(work, 'cli.cjs');
await build({
  entryPoints: [join(cliRoot, 'dist/index.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  external: ['playwright', 'playwright-core'],
  banner: {
    js: [
      'const __emitWarning = process.emitWarning;',
      "process.emitWarning = function (w, ...a) { const t = typeof a[0] === 'string' ? a[0] : a[0] && a[0].type; if (t === 'ExperimentalWarning') return; return __emitWarning.call(process, w, ...a); };",
    ].join('\n'),
  },
  logLevel: 'warning',
});

// 2. Blob.
const blob = join(work, 'sea-prep.blob');
writeFileSync(
  join(work, 'sea-config.json'),
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }),
);
run(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')]);

// 3. Inject into a copy of Node.
const exe = join(work, target.exe);
copyFileSync(values.node ?? process.execPath, exe);
chmodSync(exe, 0o755);
if (target.os === 'mac') run('codesign', ['--remove-signature', exe]);
const postject = join(repoRoot, 'node_modules/postject/dist/cli.js');
const postjectArgs = [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (target.os === 'mac') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, postjectArgs);
if (target.os === 'mac') signMac(exe);

// Developer ID signing when MAC_CODESIGN_IDENTITY is set (the release
// workflow imports the certificate into a temporary keychain), ad-hoc
// otherwise — arm64 macOS refuses to run an unsigned binary. Hardened
// runtime needs the JIT entitlements or V8 dies with SIGTRAP.
function signMac(file) {
  const identity = process.env.MAC_CODESIGN_IDENTITY;
  if (!identity) {
    run('codesign', ['--sign', '-', '--force', file]);
    return;
  }
  run('codesign', [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    '--entitlements', join(cliRoot, 'entitlements.mac.plist'),
    '--sign', identity,
    file,
  ]);
  notarizeMac(file);
}

// A bare executable can't be stapled; Gatekeeper looks the ticket up online
// the first time a quarantined copy runs. Skipped without API credentials.
function notarizeMac(file) {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.log('Notarization skipped: APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER not set.');
    return;
  }
  const zip = join(work, 'notarize.zip');
  run('ditto', ['-c', '-k', '--keepParent', file, zip]);
  const auth = ['--key', APPLE_API_KEY, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER];
  const result = JSON.parse(
    execFileSync('xcrun', ['notarytool', 'submit', zip, ...auth, '--wait', '--output-format', 'json'], {
      encoding: 'utf8',
    }),
  );
  rmSync(zip);
  console.log(`Notarization ${result.id}: ${result.status}`);
  if (result.status !== 'Accepted') {
    // Apple's log says which file or signature was rejected.
    run('xcrun', ['notarytool', 'log', result.id, ...auth]);
    throw new Error(`Notarization failed with status ${result.status}`);
  }
}

// 4. Pack.
const base = `EXIT-SEO-Crawler-CLI-${version}-${target.label}`;
if (target.os === 'mac') {
  run('tar', ['-czf', join(out, `${base}.tar.gz`), '-C', work, target.exe]);
} else {
  // PowerShell rather than `tar`: on CI runners Git's GNU tar can shadow
  // Windows' bsdtar, and only the latter writes zip files.
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Force -Path '${exe}' -DestinationPath '${join(out, `${base}.zip`)}'`,
  ]);
}
console.log(`CLI built: ${join(out, base)}`);
