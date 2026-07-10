import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Load .env files explicitly so server.proxy can read VITE_BASE_PATH.
  // Vite's process.env doesn't auto-include .env values for server config;
  // only client-side VITE_* vars are exposed by default.
  const env = loadEnv(mode, process.cwd(), '')
  const basePath = env.VITE_BASE_PATH
    ? '/' + env.VITE_BASE_PATH.replace(/^\//, '').replace(/\/+$/, '')
    : ''
  return {
    plugins: [react()],
    root: '.',
    base: basePath ? basePath + '/' : './',
    build: {
      outDir: '../dist',
      emptyOutDir: true
    },
    server: {
      port: 5173,
      proxy: {
        [basePath + '/api']: {
          target: 'http://localhost:3001',
          changeOrigin: true,
          rewrite: (p) => p.replace(basePath, '')
        },
        [basePath + '/socket.io']: {
          target: 'http://localhost:3001',
          changeOrigin: true,
          rewrite: (p) => p.replace(basePath, ''),
          ws: true
        }
      }
    }
  }
})
