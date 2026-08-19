import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: 'chrome116',
    // Extension pages are loaded from disk; readable output helps debugging.
    minify: false,
    sourcemap: true,
  },
  test: {
    // Node by default; DOM-dependent suites opt in with a per-file
    // `@vitest-environment jsdom` docblock, so the fast suites stay fast.
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
