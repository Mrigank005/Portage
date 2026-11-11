// Portage's website: static output, built from the repository's own files (runs, results, references).
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://portage-dev.onrender.com",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory" },
  markdown: {
    shikiConfig: { theme: "github-dark-dimmed", wrap: false },
  },
  devToolbar: { enabled: false },
});
