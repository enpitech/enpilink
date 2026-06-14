import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { enpilink } from "enpilink/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [enpilink(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
