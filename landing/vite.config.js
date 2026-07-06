import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Multi-page build — one HTML entry per page. The docs are a full
      // multi-page section: one route per sidebar item under /docs/. Paths
      // are resolved relative to the project root.
      input: {
        main: "index.html",
        changelog: "changelog.html",
        docs: "docs/index.html",
        "docs-quickstart": "docs/quickstart.html",
        "docs-two-modes": "docs/two-modes.html",
        "docs-providers": "docs/providers.html",
        "docs-delegation": "docs/delegation.html",
        "docs-failover": "docs/failover.html",
        "docs-dashboard": "docs/dashboard.html",
        "docs-safety": "docs/safety.html",
        "docs-commands": "docs/commands.html",
        "docs-faq": "docs/faq.html",
      },
    },
  },
});
