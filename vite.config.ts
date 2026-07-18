import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: true,        // automatically opens browser on npm run dev
  },
  preview: {
    port: 4173,
  },
});
