import react from "@vitejs/plugin-react";
import { enpilink } from "enpilink/vite";
import { defineConfig, type PluginOption } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [enpilink() as PluginOption, react()],
});
