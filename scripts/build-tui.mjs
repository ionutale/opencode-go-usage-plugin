import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// `exports` encapsulation blocks the bare `@opentui/solid/scripts/...` subpath,
// so import the transform by file URL from the installed package.
const { transformSolidSource } = await import(
  new URL("../node_modules/@opentui/solid/scripts/solid-transform.js", import.meta.url)
)

const rootDirectory = fileURLToPath(new URL("..", import.meta.url))
const sourceDirectory = resolve(rootDirectory, "src")
const sourcePath = resolve(sourceDirectory, "tui.tsx")
const outputDirectory = resolve(rootDirectory, "dist")
const outputPath = resolve(outputDirectory, "tui.js")

const source = await readFile(sourcePath, "utf8")
const transformed = await transformSolidSource(source, { filename: sourcePath })

// The transform preserves relative import specifiers, but `dist/tui.js` no
// longer sits next to its siblings. Repoint each relative import at the shipped
// `src/` file so packaged installs resolve (`files` ships `src/`; Bun loads the
// `.ts` sources natively).
const extensions = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"]
const resolveRelativeImport = (specifier) => {
  for (const extension of extensions) {
    const candidate = resolve(sourceDirectory, specifier + extension)
    if (existsSync(candidate)) {
      return relative(outputDirectory, candidate).replaceAll("\\", "/")
    }
  }
  throw new Error(`Cannot resolve relative import ${JSON.stringify(specifier)} from ${sourcePath}`)
}
const output = transformed.replace(
  /(\bfrom\s+["'])(\.[^"']*)(["'])/g,
  (_match, prefix, specifier, suffix) => `${prefix}${resolveRelativeImport(specifier)}${suffix}`,
)

await mkdir(outputDirectory, { recursive: true })
await writeFile(outputPath, output)
console.log(`wrote ${outputPath}`)
