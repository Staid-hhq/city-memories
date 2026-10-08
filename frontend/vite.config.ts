import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { Agent } from 'node:http'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: false,
        // Large imports make hundreds of requests. Reuse a bounded local pool
        // instead of the proxy default (a new Connection: close socket each time).
        agent: new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 }),
      },
    },
  },
})
