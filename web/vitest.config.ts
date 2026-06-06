import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@saivage/contracts': resolve(__dirname, '../src/contracts'),
      '@saivage/schemas': resolve(__dirname, '../src/schemas'),
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,js}'],
    globals: false,
    // jsdom >= 25 may need the URL pattern; our fetch mock works with globalThis.fetch
  },
});
