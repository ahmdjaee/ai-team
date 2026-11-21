import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

const LEAN_LOWLIGHT = fileURLToPath(new URL("./web/lib/lowlight-lean.ts", import.meta.url));

/**
 * `@git-diff-view/lowlight` memuat semua bahasa highlight.js (±850 kB). Hanya impor `lowlight` dari paket itu yang
 * dialihkan ke `web/lib/lowlight-lean.ts`; modul pengganti sendiri tetap memakai `lowlight` asli.
 */
function leanLowlight(): Plugin {
  return {
    name: "ai-team:lean-lowlight",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "lowlight" && importer?.includes("@git-diff-view/lowlight")) return LEAN_LOWLIGHT;
      return null;
    },
  };
}

export default defineConfig({
  root: "web",
  publicDir: "public",
  plugins: [leanLowlight(), react(), tailwind()],
  // ai-agent-auth/react mengimpor react dari node_modules-nya sendiri kalau terpasang terisolasi: pastikan satu salinan.
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    host: "127.0.0.1",
    port: 4321,
    proxy: {
      // ws: true → WebSocket /api/ws ikut diteruskan (satu sambungan per tab untuk semua event live).
      "/api": { target: "http://127.0.0.1:4320", changeOrigin: true, ws: true },
      "/demo": { target: "http://127.0.0.1:4320", changeOrigin: true },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // Pustaka yang jarang berubah dipisah dari kode app: chunk utama di bawah batas 500 kB, dan browser
        // tetap memakai cache vendor saat hanya kode app yang berubah.
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|cookie|set-cookie-parser)[\\/]/,
            },
            { name: "vendor-markdown", test: /node_modules[\\/](markdown-it|entities|linkify-it|mdurl|uc\.micro|punycode\.js)[\\/]/ },
          ],
        },
      },
    },
  },
});
