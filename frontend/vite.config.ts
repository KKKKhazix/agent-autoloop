import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
const target = process.env.AGENT_AUTOLOOP_URL || "http://127.0.0.1:7317";
const proxy = { "/v1": { target, changeOrigin: true } };
export default defineConfig({
  plugins: [vue()],
  server: { host: "127.0.0.1", proxy },
  preview: { host: "127.0.0.1", proxy },
});
