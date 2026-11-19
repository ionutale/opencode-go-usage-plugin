import { gui } from "@opencode/plugin/gui/vite"
import { defineConfig } from "vite"

// Builds the desktop app's `./gui-experimental` bundle: one CommonJS file at
// dist/gui-experimental.cjs, the file package.json exports to OpenCode Desktop.
export default defineConfig({ plugins: [gui()] })
