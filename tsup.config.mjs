import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

const define = {
  __MOLESIGNAL_RUM_VERSION__: JSON.stringify(packageJson.version),
};

// `dist` is emptied by the build script, so the two builds never clean each other.
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/react.ts'],
    format: ['esm', 'cjs'],
    clean: false,
    splitting: true,
    sourcemap: true,
    treeshake: true,
    external: ['react'],
    define,
  },
  {
    // A single file for <script> tags and CDNs; it defines the global `MoleSignalRum`.
    entry: { 'molesignal-rum': 'src/global.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2020',
    clean: false,
    splitting: false,
    sourcemap: true,
    minify: true,
    treeshake: true,
    noExternal: [/.*/],
    outExtension: () => ({ js: '.js' }),
    define,
  },
]);
