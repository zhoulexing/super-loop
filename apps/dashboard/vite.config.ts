import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 开发时 /api 代理到本地 server（pnpm dev 同时启动两者）；构建产物由 server 托管在 /。
const target = process.env.SUPER_LOOP_API_URL ?? 'http://127.0.0.1:7300';

export default defineConfig({
  plugins: [react()],
  // 直接打包 workspace 包的源码，开发时无需先 build（docs/development.md「包的构建约定」）
  resolve: { conditions: ['@super-loop/source'] },
  server: {
    port: 5173,
    proxy: { '/api': { target, changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
