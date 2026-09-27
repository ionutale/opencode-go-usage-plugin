// Server entrypoint for directory-path plugin loading.
// OpenCode resolves a configured plugin directory as `<dir>/server` (then
// `<dir>/index`); this file re-exports the real module so the local directory
// can be used directly as a `plugins` entry.
export { default } from "./src/index.ts"
