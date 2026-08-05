import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  clean: true,
  splitting: true,
  sourcemap: true,
  treeshake: true,
  define: {
    __MOLESIGNAL_RUM_VERSION__: JSON.stringify(packageJson.version),
  },
});
