import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      assert: 'assert',
      events: 'events',
    },
  },
  define: {
    global: 'globalThis',
  },
});
