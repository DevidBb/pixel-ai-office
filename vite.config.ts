import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// По умолчанию офис открыт только на этом компьютере. Доступ из локальной сети — `npm run dev:lan`.
const host = process.env.OFFICE_HOST || '127.0.0.1';

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  },
  preview: { host }
});
