import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: {
    port: 5173,
    // /login and /logout are server routes too, not client-side paths.
    proxy: {
      '/api': 'http://localhost:3006',
      '/login': 'http://localhost:3006',
      '/logout': 'http://localhost:3006',
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
