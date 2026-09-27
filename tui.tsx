// TUI entrypoint for directory-path plugin loading.
// OpenCode resolves a plugin's TUI module as `<dir>/tui`; this file
// re-exports the real sidebar plugin so the local directory can be used
// directly as a `plugins` entry.
export { default } from "./src/tui.tsx"
