import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(async ({ mode }) => {
  // Only load the Lovable dev-only component tagger in dev mode AND only
  // when the developer opts in via `LOVABLE=1` (or the legacy VITE_LOVABLE=1).
  // The plugin is otherwise never imported, so production builds don't pull
  // it into the bundle.
  const isDev = mode === "development";
  const lovableEnabled =
    isDev &&
    (process.env.LOVABLE === "1" ||
      process.env.VITE_LOVABLE === "1" ||
      process.env.LOVABLE_TAGGER === "1");

  const plugins: Plugin[] = [react()];

  if (lovableEnabled) {
    const { componentTagger } = await import("lovable-tagger");
    plugins.push(componentTagger());
  }

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      rollupOptions: {
        output: {
          // Split stable third-party deps into their own chunks so that
          // app-code changes don't invalidate the browser cache for the
          // vendor code, and the browser can parallelize downloads.
          manualChunks: (id: string) => {
            if (!id.includes("node_modules")) return;
            // konva/react-konva: large canvas lib, shared between the main
            // bundle (renderTextLayers) and the lazy TextOverlay chunk.
            // Splitting avoids duplication and keeps it cacheable.
            if (
              id.includes("/konva/") ||
              id.includes("react-konva")
            ) {
              return "konva";
            }
            // Radix UI primitives — 10 packages, change only on dep bumps.
            if (id.includes("@radix-ui")) return "radix";
            // EXIF parsing — exifr is sizable; isolating it keeps it out of
            // the main parse/eval path even though it's imported eagerly.
            if (id.includes("/exifr/") || id.includes("/piexifjs/")) {
              return "imaging";
            }
            // React runtime + router + query — the most stable deps,
            // rarely change between app updates.
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/scheduler/") ||
              id.includes("react-router") ||
              id.includes("@tanstack/react-query")
            ) {
              return "react-vendor";
            }
          },
        },
      },
    },
  };
});
