/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Tauri expects the dev server on a fixed port and does not use HMR over websockets.
// TAURI_DEV_HOST is set by `tauri dev` when building for mobile; ignored on desktop.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/._*', '**/node_modules/**'],
    coverage: {
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/index.tsx', 'src/test/**'],
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'build',
    emptyOutDir: true,
    // Tauri requires smaller chunk sizes on some platforms
    chunkSizeWarningLimit: 1600,
  },
  // Prevent Vite from obscuring Rust compile errors in the terminal
  clearScreen: false,
  server: {
    port: 3000,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: 'ws', host, port: 3001 } : undefined,
  },
});
