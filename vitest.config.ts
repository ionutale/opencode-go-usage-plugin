import { defineConfig } from "vitest/config"

// The tests cover pure logic, so they run in Node and do not load the GUI build
// config, whose Solid plugin would pull in a DOM environment.
export default defineConfig({ test: { environment: "node" } })
