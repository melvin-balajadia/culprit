import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two entries: the side panel page and the background service worker (fixed name for the manifest).
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rolldownOptions: {
      input: { panel: "panel.html", background: "src/background.ts" },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"
      }
    }
  }
});
