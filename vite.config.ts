import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = `http://127.0.0.1:${process.env.PORT ?? "8787"}`;

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ["roses-macbook-pro"],
    // Trailing slashes matter: "/api" alone would also catch src/web/api.ts.
    proxy: {
      "/api/": { target: server, ws: true },
      "/auth/": server,
    },
  },
});
