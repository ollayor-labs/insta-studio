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
  };
});
