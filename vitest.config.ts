import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [
    {
      // vite-node (Vitest 2) only knows `node:test` as a prefix-only builtin:
      // it strips `node:` from `node:sqlite` and then looks for a package
      // called `sqlite`. Serve that id from Node's own builtin instead.
      name: 'node-sqlite-builtin',
      enforce: 'pre',
      resolveId: (id) => (id === 'sqlite' || id === 'node:sqlite' ? '\0node-sqlite' : null),
      load: (id) =>
        id === '\0node-sqlite'
          ? `const m = process.getBuiltinModule('node:sqlite');
             export const DatabaseSync = m.DatabaseSync;
             export default m;`
          : null,
    },
  ],
  resolve: {
    // Test the sources, not a stale `dist/`: no build step before `npm test`.
    alias: {
      '@freecrawl/core': src('core'),
      '@freecrawl/db': src('db'),
      '@freecrawl/shared-types': src('shared-types'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Real crawls against a local server: seconds, not milliseconds.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
