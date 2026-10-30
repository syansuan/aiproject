import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],

  // 复用根目录那份 .env —— 密钥只有一处真源，不在这里再抄一份。
  // 代价：Vite 默认只把带 VITE_ 前缀的变量暴露给浏览器，
  // 所以下面用 envPrefix 额外放行 ZHIPU_，和根目录的变量名保持一致。
  envDir: path.resolve(root, '..'),
  envPrefix: ['VITE_', 'ZHIPU_'],

  server: {
    port: 5173,
    // proxy：浏览器只认同源（localhost:5173），直接请求 127.0.0.1:8000 会被 CORS 拦下。
    // 开发期让 Vite 把 /api 转发给 FastAPI，后端不用加 CORS 中间件；
    // 上线时由 Nginx 做同样的事。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/zhipu': {
        // ← 新增
        target: 'https://open.bigmodel.cn',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/zhipu/, '/api/paas/v4'),
      },
    },
  },
});
