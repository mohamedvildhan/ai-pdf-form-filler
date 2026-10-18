import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native / heavy node-only packages out of the bundler so the API
  // routes can require them at runtime.
  // pdfjs is only used by scripts/render-pages.mjs (child process), not the app.
  serverExternalPackages: ["pdf-lib", "mammoth"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
