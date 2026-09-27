import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { UsageError, createUsageService } from "../src/service"
import { formatUsageRows } from "../src/usage"

async function readKeyFromAuthFile(): Promise<string | undefined> {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  try {
    const raw = await readFile(join(dataHome, "opencode", "auth.json"), "utf8")
    const auth = JSON.parse(raw) as Record<string, { key?: unknown } | undefined>
    const key = auth["opencode-go"]?.key
    return typeof key === "string" && key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

const key = process.env.OPENCODE_API_KEY ?? (await readKeyFromAuthFile())

if (!key) {
  console.error("No OpenCode Go key found.")
  console.error("Run /connect in OpenCode and choose OpenCode Go, or set OPENCODE_API_KEY.")
  process.exit(1)
}

const service = createUsageService({ resolveKey: async () => key })

try {
  const result = await service.get()
  console.log("OpenCode Go usage")
  console.log(formatUsageRows(result, Date.now()).join("\n"))
  if (result.stale) console.log("(stale: showing the last successful fetch)")
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.type}: ${error.message}`)
  } else {
    console.error(error)
  }
  process.exit(1)
}
