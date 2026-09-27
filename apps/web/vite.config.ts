import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Read API_HOST/API_PORT from the repository-root .env (no secrets are exposed to the client:
  // only VITE_-prefixed variables ever reach the browser bundle).
  const env = loadEnv(mode, '../..', '');
  const apiHost = env.API_HOST && env.API_HOST !== '0.0.0.0' ? env.API_HOST : '127.0.0.1';
  const apiTarget = `http://${apiHost}:${env.API_PORT ?? '3000'}`;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin development: the browser only talks to the Vite origin, which proxies /api.
      // Cookies stay first-party and the approved cookie/CSRF model is unchanged.
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false, xfwd: false },
      },
    },
    build: { sourcemap: true },
  };
});
