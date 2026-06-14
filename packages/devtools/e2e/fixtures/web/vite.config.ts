import path from "node:path";
import react from "@vitejs/plugin-react";
import { enpilink } from "enpilink/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [enpilink(), react()],
  root: __dirname,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
