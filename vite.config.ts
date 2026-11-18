import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        // 不要开启 changeOrigin：后端 Origin 校验比较 `Origin` 与 `Host`，
        // 改写 Host 会让开发服务器转发来的同源请求被误判为跨站（403）。
        // 保留浏览器原始 Host（如 localhost:5199）才能通过校验。
      },
    },
  },
  test: {
    environment: "happy-dom",
    // 服务端测试在文件首行写 `// @vitest-environment node` 单独切换。
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
