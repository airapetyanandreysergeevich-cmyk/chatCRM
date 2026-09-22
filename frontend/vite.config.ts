import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Относительные адреса файлов сборки: их достраивает <base> в index.html.
  // Так одна и та же сборка работает и в корне сайта, и по адресу
  // /b/<код>/ — когда в Основу заходят из интернета.
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4000" },
  },
});
