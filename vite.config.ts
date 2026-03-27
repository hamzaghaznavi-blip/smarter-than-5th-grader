import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

/** Relative base: works on GitHub Pages for any repo name (no rebuild when you rename). */
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: false,
    /** Listen on all interfaces so `localhost` / `127.0.0.1` / LAN IP all work. */
    host: true,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'react-vendor';
          if (id.includes('node_modules/motion')) return 'motion';
          if (id.includes('node_modules/canvas-confetti')) return 'confetti';
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
