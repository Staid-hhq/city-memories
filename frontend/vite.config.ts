import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { Agent } from 'node:http'

const testBackendPort = Number(process.env.CITY_MEMORIES_E2E_BACKEND_PORT ?? 8000)
if (!Number.isInteger(testBackendPort) || testBackendPort < 1024 || testBackendPort > 65535) throw new Error('Invalid CITY_MEMORIES_E2E_BACKEND_PORT')

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${testBackendPort}`,
        changeOrigin: false,
        // Large imports make hundreds of requests. Reuse a bounded local pool
        // instead of the proxy default (a new Connection: close socket each time).
        agent: new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 }),
      },
    },
  },
})
