# OpenCode Go Usage Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, verify, and publish a public OpenCode plugin that shows OpenCode Go plan usage (rolling / weekly / monthly) as three color-coded bars in the session sidebar footer.

**Architecture:** A server plugin resolves the `opencode-go` credential through the integration API, fetches `GET https://opencode.ai/zen/go/v1/usage` with a 15s cache and 5-minute stale fallback, and exposes the result over a typed RPC (`id: go-usage`, method `get`). A TUI plugin calls that RPC and renders the `sidebar.footer` slot, polling every 30s and re-rendering countdowns every 30s. Credentials never leave the server process.

**Tech Stack:** TypeScript (strict, no build step — sources are shipped), `@opencode/plugin` 2.x (`./rpc`, `./tui`, plugin hooks), `solid-js` JSX via `@opentui/solid`, vitest, tsx, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-27-opencode-go-usage-design.md`

## Global Constraints

- OpenCode V2 only; plugin API `@opencode/plugin` 2.x (tested against CLI v2.0.18).
- No credentials in any tracked file. The key is resolved at runtime on the server and must never be logged, printed, or committed.
- Upstream endpoint only: `https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <key>`.
- Constants (exact values): `CACHE_TTL_MS = 15_000`, `STALE_MAX_AGE_MS = 300_000`, `REFRESH_MS = 30_000`, `TICK_MS = 30_000`, bar width `10`.
- Color thresholds: green `< 50`, yellow `50–74`, red `≥ 75`. Colors: `#22c55e` / `#eab308` / `#ef4444`.
- Formatting: `Xd Yh` ≥ 1 day, `Xh Ym` ≥ 1 hour, otherwise `Xm`; past/invalid timestamps render `0m`.
- Package name `opencode-go-usage-plugin`; export entries `.` → `src/index.ts`, `./tui` → `src/tui.tsx`, `./rpc` → `src/rpc.ts`.
- Use pnpm (never npm) for installs and scripts; Conventional Commits.
- Work in `/Users/ionutale/developer/opencode-go-usage-plugin` (git repo already initialized on `main` with the spec committed).
- Never run the smoke script or integration checks in a way that writes the API key to disk.

## Review Focus

The inputs/conditions below are implied by the spec but not fully exercised by ordinary happy-path tests; each gets a test in the owning task, except the ones marked visual.

1. **Narrow sidebar / terminal width** — rows are ~36 visible columns; clipping or wrapping must not crash the render. Visual check in Task 6.
2. **Past, invalid, or clock-skewed `resetsAt`** — must render `0m`, never throw. Tested in Task 1.
3. **Non-JSON upstream body** (captive portal / proxy returning HTML) — must surface `upstream` or stale data, never an uncaught exception. Tested in Task 2.
4. **Untyped/prefixed RPC errors on the client** — declared errors reject client-side with shapes like `{type:"no_credential"}` or `{type:"rpc.go-usage.no_credential"}`; all must produce friendly text. Tested in Task 1; end-to-end check in Task 6.
5. **Teardown or reload mid-fetch** — an aborted in-flight fetch must reject (no stale fallback) and both TUI timers must be cleared. Tested in Task 2; cleanup code in Task 4.

---

### Task 1: Scaffold the package and pure usage helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`
- Create: `src/usage.ts`
- Test: `src/usage.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: types `UsageWindow`, `UsageWindows`, `UsageResult`; class `UsageParseError`; constants `GREEN`, `YELLOW`, `RED`, `ERROR_TEXT`; functions `parseUsageResponse(input: unknown): UsageWindows`, `formatDuration(ms: number): string`, `formatResetsIn(resetsAt: string, nowMs: number): string`, `barSegments(percent: number, width?: number): string`, `usageColor(percent: number): string`, `describeRpcError(error: unknown): string`, `formatUsageRows(result: UsageResult, nowMs: number): string[]`. Later tasks import exactly these names.

- [ ] **Step 1: Write scaffold files**

`.gitignore`:

```gitignore
node_modules/
dist/
.DS_Store
*.capture.txt
```

`LICENSE` (MIT, standard text):

```text
MIT License

Copyright (c) 2026 Ion Utale

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "preserve",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "scripts"]
}
```

`package.json` — create this shape, then let Step 2 fill in real dependency versions:

```json
{
  "name": "opencode-go-usage-plugin",
  "version": "0.1.0",
  "description": "OpenCode Go plan usage (rolling / weekly / monthly) in the session sidebar",
  "type": "module",
  "license": "MIT",
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
    "./rpc": "./src/rpc.ts"
  },
  "files": ["src"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "smoke": "tsx scripts/smoke.ts"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
cd /Users/ionutale/developer/opencode-go-usage-plugin
pnpm add @opencode/plugin@latest
pnpm add -D typescript vitest tsx @types/node @opentui/core @opentui/solid solid-js
```

Expected: `package.json` gains `dependencies` (`@opencode/plugin`) and `devDependencies` with concrete versions; `pnpm-lock.yaml` is created. If `@opencode/plugin` installs with peer warnings about `@opentui/*` or `solid-js`, that is expected (they are also declared as our peerDependencies in a later step — add them now):

```bash
pnpm pkg set peerDependencies.@opentui/core=">=0.5.8" peerDependencies.@opentui/solid=">=0.5.8" peerDependencies.solid-js=">=1.9.0"
```

- [ ] **Step 3: Write the failing tests**

`src/usage.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  barSegments,
  describeRpcError,
  formatDuration,
  formatResetsIn,
  formatUsageRows,
  parseUsageResponse,
  usageColor,
  UsageParseError,
} from "./usage"

const SAMPLE = {
  usage: {
    rolling: { status: "ok", percent: 40, resetsAt: "2026-09-27T19:03:37.947Z" },
    weekly: { status: "ok", percent: 77, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 64, resetsAt: "2026-10-05T10:02:18.000Z" },
  },
}

describe("parseUsageResponse", () => {
  it("parses a valid response", () => {
    const usage = parseUsageResponse(SAMPLE)
    expect(usage.rolling.percent).toBe(40)
    expect(usage.weekly.resetsAt).toBe("2026-09-28T00:00:00.000Z")
    expect(usage.monthly.status).toBe("ok")
  })

  it("rejects a response without usage", () => {
    expect(() => parseUsageResponse({})).toThrow(UsageParseError)
  })

  it("rejects a missing window", () => {
    const broken = { usage: { ...SAMPLE.usage, weekly: undefined } }
    expect(() => parseUsageResponse(broken)).toThrow(UsageParseError)
  })

  it("rejects a string percent", () => {
    const broken = { usage: { ...SAMPLE.usage, rolling: { ...SAMPLE.usage.rolling, percent: "40" } } }
    expect(() => parseUsageResponse(broken)).toThrow(UsageParseError)
  })

  it("rejects an invalid resetsAt", () => {
    const broken = { usage: { ...SAMPLE.usage, monthly: { ...SAMPLE.usage.monthly, resetsAt: "soon" } } }
    expect(() => parseUsageResponse(broken)).toThrow(UsageParseError)
  })
})

describe("formatDuration", () => {
  it.each([
    [0, "0m"],
    [-5000, "0m"],
    [59_999, "0m"],
    [45 * 60_000, "45m"],
    [(60 + 13) * 60_000, "1h 13m"],
    [(6 * 60 + 9) * 60_000, "6h 9m"],
    [24 * 60 * 60_000, "1d 0h"],
    [(7 * 1440 + 16 * 60) * 60_000, "7d 16h"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe("formatResetsIn", () => {
  it("formats the remaining time", () => {
    const now = Date.parse("2026-09-27T17:50:00.000Z")
    expect(formatResetsIn("2026-09-27T19:03:37.947Z", now)).toBe("1h 13m")
  })

  it("clamps past timestamps to 0m", () => {
    const now = Date.parse("2026-09-27T20:00:00.000Z")
    expect(formatResetsIn("2026-09-27T19:03:37.947Z", now)).toBe("0m")
  })

  it("clamps invalid timestamps to 0m", () => {
    expect(formatResetsIn("not-a-date", Date.now())).toBe("0m")
  })
})

describe("barSegments", () => {
  it("renders proportional segments", () => {
    expect(barSegments(0)).toBe("░░░░░░░░░░")
    expect(barSegments(40)).toBe("████░░░░░░")
    expect(barSegments(100)).toBe("██████████")
  })

  it("rounds and clamps out-of-range values", () => {
    expect(barSegments(44)).toBe("████░░░░░░")
    expect(barSegments(-10)).toBe("░░░░░░░░░░")
    expect(barSegments(140)).toBe("██████████")
    expect(barSegments(Number.NaN)).toBe("░░░░░░░░░░")
  })
})

describe("usageColor", () => {
  it.each([
    [0, "#22c55e"],
    [49, "#22c55e"],
    [50, "#eab308"],
    [74, "#eab308"],
    [75, "#ef4444"],
    [100, "#ef4444"],
  ])("maps %d to %s", (percent, expected) => {
    expect(usageColor(percent)).toBe(expected)
  })
})

describe("describeRpcError", () => {
  it("maps unprefixed error types", () => {
    expect(describeRpcError({ type: "unauthorized" })).toBe("check API key")
    expect(describeRpcError({ type: "no_credential" })).toBe("not connected")
  })

  it("maps rpc-prefixed error types", () => {
    expect(describeRpcError({ type: "rpc.go-usage.unauthorized" })).toBe("check API key")
    expect(describeRpcError({ type: "rpc.go-usage.forbidden" })).toBe("Go plan required")
  })

  it("falls back to error messages", () => {
    expect(describeRpcError(new Error("boom"))).toBe("boom")
    expect(describeRpcError({ data: { message: "inner" } })).toBe("inner")
  })

  it("falls back to unreachable", () => {
    expect(describeRpcError({ type: "surprise" })).toBe("unreachable")
    expect(describeRpcError(undefined)).toBe("unreachable")
  })
})

describe("formatUsageRows", () => {
  it("formats one aligned row per window", () => {
    const now = Date.parse("2026-09-27T17:50:00.000Z")
    const rows = formatUsageRows(
      { usage: parseUsageResponse(SAMPLE), fetchedAt: "2026-09-27T17:50:00.000Z" },
      now,
    )
    expect(rows).toEqual([
      "Rolling  ████░░░░░░   40%  1h 13m",
      "Weekly   ██████████   77%  6h 10m",
      "Monthly  ██████░░░░   64%  7d 16h",
    ])
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `Failed to load ./usage` / module not found.

- [ ] **Step 5: Write the implementation**

`src/usage.ts`:

```ts
export type UsageWindow = {
  status: string
  percent: number
  resetsAt: string
}

export type UsageWindows = {
  rolling: UsageWindow
  weekly: UsageWindow
  monthly: UsageWindow
}

export type UsageResult = {
  usage: UsageWindows
  /** ISO timestamp of the last successful upstream fetch */
  fetchedAt: string
  /** True when this is cached data served after a failed refresh */
  stale?: boolean
}

export class UsageParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageParseError"
  }
}

export const GREEN = "#22c55e"
export const YELLOW = "#eab308"
export const RED = "#ef4444"

export const ERROR_TEXT: Record<string, string> = {
  no_credential: "not connected",
  unauthorized: "check API key",
  forbidden: "Go plan required",
  upstream: "unreachable",
}

const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const

function parseWindow(value: unknown, key: string): UsageWindow {
  if (typeof value !== "object" || value === null) throw new UsageParseError(`usage.${key} is not an object`)
  const record = value as Record<string, unknown>
  if (typeof record.status !== "string") throw new UsageParseError(`usage.${key}.status is not a string`)
  if (typeof record.percent !== "number" || !Number.isFinite(record.percent)) {
    throw new UsageParseError(`usage.${key}.percent is not a number`)
  }
  if (typeof record.resetsAt !== "string" || Number.isNaN(Date.parse(record.resetsAt))) {
    throw new UsageParseError(`usage.${key}.resetsAt is not a valid date`)
  }
  return { status: record.status, percent: record.percent, resetsAt: record.resetsAt }
}

export function parseUsageResponse(input: unknown): UsageWindows {
  if (typeof input !== "object" || input === null) throw new UsageParseError("response is not an object")
  const usage = (input as Record<string, unknown>).usage
  if (typeof usage !== "object" || usage === null) throw new UsageParseError("response.usage is missing")
  const record = usage as Record<string, unknown>
  const result = {} as UsageWindows
  for (const key of WINDOW_KEYS) result[key] = parseWindow(record[key], key)
  return result
}

/** Remaining time as `Xd Yh`, `Xh Ym`, or `Xm`. Past or invalid values clamp to `0m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m"
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatResetsIn(resetsAt: string, nowMs: number): string {
  const target = Date.parse(resetsAt)
  if (Number.isNaN(target)) return "0m"
  return formatDuration(target - nowMs)
}

/** Filled/empty bar segments, e.g. `barSegments(40)` -> `████░░░░░░`. */
export function barSegments(percent: number, width = 10): string {
  const bounded = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  const filled = Math.min(width, Math.max(0, Math.round((bounded / 100) * width)))
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function usageColor(percent: number): string {
  if (percent >= 75) return RED
  if (percent >= 50) return YELLOW
  return GREEN
}

/** Maps an RPC error to short UI text. Accepts unprefixed or `rpc.<id>.`-prefixed types. */
export function describeRpcError(error: unknown): string {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined
  const data =
    typeof record?.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : undefined
  const rawType =
    typeof record?.type === "string" ? record.type : typeof data?.type === "string" ? data.type : undefined
  if (rawType) {
    const normalized = rawType.replace(/^rpc\.[^.]+\./, "")
    const known = ERROR_TEXT[normalized]
    if (known) return known
  }
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof record?.message === "string" && record.message.length > 0) return record.message
  if (typeof data?.message === "string" && data.message.length > 0) return data.message
  return ERROR_TEXT.upstream
}

/** One aligned row per window, in the same shape the sidebar renders and the smoke script prints. */
export function formatUsageRows(result: UsageResult, nowMs: number): string[] {
  return WINDOW_KEYS.map((key) => {
    const window = result.usage[key]
    const label = `${key[0].toUpperCase()}${key.slice(1)}`
    const percent = String(Math.round(window.percent)).padStart(3)
    return `${label.padEnd(8)} ${barSegments(window.percent)}  ${percent}%  ${formatResetsIn(window.resetsAt, nowMs)}`
  })
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all tests green. If `formatUsageRows` alignment fails, check that every label is padded to 8 characters before the bar.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0. (If `src/index.ts`/`src/tui.tsx` do not exist yet, tsc only checks existing files under `include`; that is fine.)

- [ ] **Step 8: Commit**

```bash
git add .gitignore LICENSE tsconfig.json package.json pnpm-lock.yaml src/usage.ts src/usage.test.ts
git commit -m "chore: scaffold plugin package and add usage helpers"
```

---

### Task 2: Cached usage service with error mapping

**Files:**
- Create: `src/service.ts`
- Test: `src/service.test.ts`

**Interfaces:**
- Consumes: `parseUsageResponse`, `UsageParseError`, `UsageResult` from `./usage` (Task 1).
- Produces: constants `USAGE_ENDPOINT`, `CACHE_TTL_MS`, `STALE_MAX_AGE_MS`; type `UsageErrorType`; class `UsageError` (fields `type`, `message`); type `UsageServiceOptions = { resolveKey: () => Promise<string | undefined>; fetch?: typeof globalThis.fetch; now?: () => number }`; function `createUsageService(options): UsageService` where `UsageService = { get(signal?: AbortSignal): Promise<UsageResult> }`. Task 3 adapts `UsageError` to RPC errors; Task 5 calls `createUsageService` directly.

- [ ] **Step 1: Write the failing tests**

`src/service.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { CACHE_TTL_MS, STALE_MAX_AGE_MS, UsageError, createUsageService } from "./service"

const SAMPLE = {
  usage: {
    rolling: { status: "ok", percent: 40, resetsAt: "2026-09-27T19:03:37.947Z" },
    weekly: { status: "ok", percent: 77, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 64, resetsAt: "2026-10-05T10:02:18.000Z" },
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function makeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    if (next instanceof Error) throw next
    if (!next) throw new Error("no more fake responses")
    return next
  })
  return { fn: fn as unknown as typeof globalThis.fetch, calls }
}

function makeService(
  resolveKey: () => Promise<string | undefined>,
  responses: Array<Response | Error>,
  startTime = 1_000_000,
) {
  const { fn, calls } = makeFetch(responses)
  let now = startTime
  const service = createUsageService({ resolveKey, fetch: fn, now: () => now })
  return { service, calls, advance: (ms: number) => (now += ms) }
}

afterEach(() => vi.useRealTimers())

describe("createUsageService", () => {
  it("fetches, authorizes, and returns parsed usage", async () => {
    const { service, calls } = makeService(async () => "test-key", [jsonResponse(SAMPLE)])
    const result = await service.get()
    expect(result.usage.rolling.percent).toBe(40)
    expect(result.stale).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://opencode.ai/zen/go/v1/usage")
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key")
  })

  it("serves from cache within the TTL", async () => {
    const { service, calls, advance } = makeService(async () => "test-key", [jsonResponse(SAMPLE)])
    const first = await service.get()
    advance(CACHE_TTL_MS - 1)
    const second = await service.get()
    expect(calls).toHaveLength(1)
    expect(second.fetchedAt).toBe(first.fetchedAt)
  })

  it("refetches after the TTL", async () => {
    const { service, calls, advance } = makeService(async () => "test-key", [
      jsonResponse(SAMPLE),
      jsonResponse(SAMPLE),
    ])
    await service.get()
    advance(CACHE_TTL_MS + 1)
    await service.get()
    expect(calls).toHaveLength(2)
  })

  it("maps HTTP 401 to unauthorized", async () => {
    const { service } = makeService(async () => "bad-key", [jsonResponse({}, 401)])
    await expect(service.get()).rejects.toMatchObject({ type: "unauthorized" })
  })

  it("maps HTTP 403 to forbidden", async () => {
    const { service } = makeService(async () => "key", [jsonResponse({}, 403)])
    await expect(service.get()).rejects.toMatchObject({ type: "forbidden" })
  })

  it("maps a non-JSON body to upstream", async () => {
    const { service } = makeService(async () => "key", [new Response("<html>portal</html>", { status: 200 })])
    await expect(service.get()).rejects.toMatchObject({ type: "upstream" })
  })

  it("reports no_credential when no key resolves", async () => {
    const { service } = makeService(async () => undefined, [jsonResponse(SAMPLE)])
    await expect(service.get()).rejects.toMatchObject({ type: "no_credential" })
  })

  it("serves stale data within five minutes of a failed refresh", async () => {
    const { service, calls, advance } = makeService(async () => "key", [
      jsonResponse(SAMPLE),
      new Error("network down"),
    ])
    const first = await service.get()
    advance(CACHE_TTL_MS + 1)
    const second = await service.get()
    expect(calls).toHaveLength(2)
    expect(second.stale).toBe(true)
    expect(second.fetchedAt).toBe(first.fetchedAt)
  })

  it("rejects when the failure outlasts the stale window", async () => {
    const { service, advance } = makeService(async () => "key", [jsonResponse(SAMPLE), new Error("network down")])
    await service.get()
    advance(STALE_MAX_AGE_MS + 1)
    await expect(service.get()).rejects.toMatchObject({ type: "upstream" })
  })

  it("rethrows aborted requests without serving stale data", async () => {
    const { service, advance } = makeService(async () => "key", [
      jsonResponse(SAMPLE),
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    ])
    await service.get()
    advance(CACHE_TTL_MS + 1)
    const controller = new AbortController()
    controller.abort()
    await expect(service.get(controller.signal)).rejects.toThrow("aborted")
  })
})

describe("UsageError", () => {
  it("carries its type", () => {
    const error = new UsageError("forbidden", "nope")
    expect(error.type).toBe("forbidden")
    expect(error.message).toBe("nope")
    expect(error).toBeInstanceOf(Error)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot resolve `./service`.

- [ ] **Step 3: Write the implementation**

`src/service.ts`:

```ts
import { UsageParseError, parseUsageResponse, type UsageResult } from "./usage"

export const USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage"
export const CACHE_TTL_MS = 15_000
export const STALE_MAX_AGE_MS = 300_000

export type UsageErrorType = "no_credential" | "unauthorized" | "forbidden" | "upstream"

export class UsageError extends Error {
  readonly type: UsageErrorType

  constructor(type: UsageErrorType, message: string) {
    super(message)
    this.name = "UsageError"
    this.type = type
  }
}

export type UsageServiceOptions = {
  resolveKey: () => Promise<string | undefined>
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export type UsageService = {
  get: (signal?: AbortSignal) => Promise<UsageResult>
}

export function createUsageService(options: UsageServiceOptions): UsageService {
  let cache: { result: UsageResult; at: number } | undefined
  const now = options.now ?? Date.now
  const doFetch = options.fetch ?? globalThis.fetch

  return {
    async get(signal) {
      if (cache && now() - cache.at < CACHE_TTL_MS) return cache.result

      try {
        const key = await options.resolveKey()
        if (!key) throw new UsageError("no_credential", "OpenCode Go is not connected")

        const response = await doFetch(USAGE_ENDPOINT, {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            "User-Agent": "opencode-go-usage-plugin/0.1.0",
          },
          signal,
        })

        if (response.status === 401) {
          throw new UsageError("unauthorized", "usage API rejected the OpenCode Go key (HTTP 401)")
        }
        if (response.status === 403) {
          throw new UsageError("forbidden", "usage API requires an OpenCode Go subscription (HTTP 403)")
        }
        if (!response.ok) {
          throw new UsageError("upstream", `usage API responded with HTTP ${response.status}`)
        }

        const usage = parseUsageResponse(await response.json())
        const result: UsageResult = { usage, fetchedAt: new Date(now()).toISOString() }
        cache = { result, at: now() }
        return result
      } catch (error) {
        if (signal?.aborted) throw error
        const enriched = error instanceof UsageError ? error : toUpstreamError(error)
        if (cache && now() - cache.at < STALE_MAX_AGE_MS) return { ...cache.result, stale: true }
        throw enriched
      }
    },
  }
}

function toUpstreamError(error: unknown): UsageError {
  if (error instanceof UsageParseError) {
    return new UsageError("upstream", `usage API returned an unexpected payload: ${error.message}`)
  }
  if (error instanceof Error) return new UsageError("upstream", error.message)
  return new UsageError("upstream", "usage API unreachable")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all service and usage tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/service.ts src/service.test.ts
git commit -m "feat: add cached usage service with typed error mapping"
```

---

### Task 3: RPC contract and server plugin

**Files:**
- Create: `src/rpc.ts`
- Create: `src/index.ts`
- Test: `src/index.test.ts`

**Interfaces:**
- Consumes: `createUsageService`, `UsageError` from `./service`; `ERROR_TEXT` from `./usage`.
- Produces: `GoUsage` (the `Rpc.define` result, id `go-usage`, method `get` with output `{ usage, fetchedAt, stale? }` and errors `no_credential | unauthorized | forbidden | upstream`); default export of `src/index.ts` is the server `Plugin.define` result (id `opencode-go-usage`); named export `extractKey(credential: unknown): string | undefined`. Task 4 imports `GoUsage` from `./rpc`; Task 5 does not touch this task's files.

- [ ] **Step 1: Write the failing tests**

`src/index.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import plugin, { extractKey } from "./index"

const SAMPLE = {
  usage: {
    rolling: { status: "ok", percent: 40, resetsAt: "2026-09-27T19:03:37.947Z" },
    weekly: { status: "ok", percent: 77, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 64, resetsAt: "2026-10-05T10:02:18.000Z" },
  },
}

type Registered = {
  definition?: { id?: string }
  implementation?: { get: (input: unknown, context: unknown) => Promise<unknown> }
}

function fakeCtx(credential: unknown) {
  const registered: Registered = {}
  const ctx = {
    integration: {
      connection: {
        active: async (id: string) => (id === "opencode-go" ? { id: "conn-1" } : undefined),
        resolve: async () => credential,
      },
    },
    rpc: {
      register: async (definition: unknown, implementation: unknown) => {
        registered.definition = definition as Registered["definition"]
        registered.implementation = implementation as Registered["implementation"]
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, registered }
}

async function invokeGet(credential: unknown) {
  const { ctx, registered } = fakeCtx(credential)
  await (plugin as unknown as { setup: (ctx: unknown) => Promise<void> }).setup(ctx)
  const get = registered.implementation!.get
  const result = await get(undefined, {
    signal: undefined,
    error: (type: string, message: string, data: unknown) => ({ error: { type, message, data } }),
  })
  return result
}

afterEach(() => vi.unstubAllGlobals())

describe("server plugin", () => {
  it("registers the go-usage RPC", async () => {
    const { ctx, registered } = fakeCtx("key")
    await (plugin as unknown as { setup: (ctx: unknown) => Promise<void> }).setup(ctx)
    expect(registered.definition?.id).toBe("go-usage")
    expect(typeof registered.implementation?.get).toBe("function")
  })

  it("returns parsed usage on success", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const result = (await invokeGet({ type: "api", key: "test-key" })) as { usage?: { rolling?: { percent?: number } } }
    expect(result.usage?.rolling?.percent).toBe(40)
  })

  it("maps a 401 to the declared unauthorized error with friendly text", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }))
    const result = (await invokeGet("bad-key")) as { error?: { type: string; message: string; data: unknown } }
    expect(result.error?.type).toBe("unauthorized")
    expect(result.error?.message).toBe("check API key")
    expect(result.error?.data).toEqual({ message: "usage API rejected the OpenCode Go key (HTTP 401)" })
  })

  it("maps a missing connection to no_credential", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const result = (await invokeGet(undefined)) as { error?: { type: string; message: string } }
    expect(result.error?.type).toBe("no_credential")
    expect(result.error?.message).toBe("not connected")
  })
})

describe("extractKey", () => {
  it("accepts a bare string", () => {
    expect(extractKey("sk-test")).toBe("sk-test")
  })

  it("accepts key/apiKey/value fields", () => {
    expect(extractKey({ type: "api", key: "sk-test" })).toBe("sk-test")
    expect(extractKey({ apiKey: "sk-test" })).toBe("sk-test")
    expect(extractKey({ value: "sk-test" })).toBe("sk-test")
  })

  it("returns undefined for unknown shapes", () => {
    expect(extractKey(undefined)).toBeUndefined()
    expect(extractKey({})).toBeUndefined()
    expect(extractKey({ key: 42 })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Write the RPC contract**

`src/rpc.ts`:

```ts
import { Rpc } from "@opencode/plugin/rpc"

const WINDOW_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string" },
    percent: { type: "number" },
    resetsAt: { type: "string" },
  },
  required: ["status", "percent", "resetsAt"],
  additionalProperties: false,
} as const

const ERROR_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
} as const

export const GoUsage = Rpc.define({
  id: "go-usage",
  methods: {
    get: {
      output: {
        type: "object",
        properties: {
          usage: {
            type: "object",
            properties: {
              rolling: WINDOW_SCHEMA,
              weekly: WINDOW_SCHEMA,
              monthly: WINDOW_SCHEMA,
            },
            required: ["rolling", "weekly", "monthly"],
            additionalProperties: false,
          },
          fetchedAt: { type: "string" },
          stale: { type: "boolean" },
        },
        required: ["usage", "fetchedAt"],
        additionalProperties: false,
      },
      errors: {
        no_credential: ERROR_SCHEMA,
        unauthorized: ERROR_SCHEMA,
        forbidden: ERROR_SCHEMA,
        upstream: ERROR_SCHEMA,
      },
    },
  },
})
```

- [ ] **Step 4: Write the server plugin**

`src/index.ts`:

```ts
import { Plugin } from "@opencode/plugin"
import { GoUsage } from "./rpc"
import { UsageError, createUsageService } from "./service"
import { ERROR_TEXT } from "./usage"

export default Plugin.define({
  id: "opencode-go-usage",
  async setup(ctx) {
    const service = createUsageService({
      resolveKey: async () => {
        const connection = await ctx.integration.connection.active("opencode-go")
        if (!connection) return undefined
        return extractKey(await ctx.integration.connection.resolve(connection))
      },
    })

    await ctx.rpc.register(GoUsage, {
      get: async (_input, context) => {
        try {
          return await service.get(context.signal)
        } catch (error) {
          if (error instanceof UsageError) {
            return context.error(error.type, ERROR_TEXT[error.type] ?? error.message, { message: error.message })
          }
          throw error
        }
      },
    })
  },
})

/** Handles both a bare secret string and credential objects with a key-ish field. */
export function extractKey(credential: unknown): string | undefined {
  if (typeof credential === "string" && credential.length > 0) return credential
  if (typeof credential === "object" && credential !== null) {
    const record = credential as Record<string, unknown>
    for (const candidate of [record.key, record.apiKey, record.value]) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate
    }
  }
  return undefined
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS. If `plugin.setup` is not directly callable on the value returned by `Plugin.define`, adapt the test helper by passing `ctx` through whatever the loader dialect expects — do not change production code for this. If typechecking complains that `ctx.error`'s `type` must be one of the declared error names, keep `error.type` (it is already that union).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0. If the RPC schema types reject `as const`, remove the `as const` from the two schema constants and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/rpc.ts src/index.ts src/index.test.ts
git commit -m "feat: expose cached Go usage over RPC from the server plugin"
```

---

### Task 4: TUI plugin — sidebar footer rendering

**Files:**
- Create: `src/tui.tsx`

**Interfaces:**
- Consumes: `GoUsage` from `./rpc` (Task 3); `barSegments`, `describeRpcError`, `formatResetsIn`, `usageColor`, types `UsageResult`, `UsageWindow` from `./usage` (Task 1).
- Produces: default export of `src/tui.tsx` — the TUI `Plugin.define` result (id `opencode-go-usage.tui`) that registers the `sidebar.footer` slot. No later task imports from this file.

This task has no unit test: JSX rendering depends on the OpenCode runtime, so its verification is the typecheck here plus the live integration checks in Task 6. The pure formatting it relies on is already covered by Task 1.

- [ ] **Step 1: Write the TUI plugin**

`src/tui.tsx`:

```tsx
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { GoUsage } from "./rpc"
import {
  barSegments,
  describeRpcError,
  formatResetsIn,
  usageColor,
  type UsageResult,
  type UsageWindow,
} from "./usage"

const REFRESH_MS = 30_000
const TICK_MS = 30_000

type ViewState =
  | { phase: "loading" }
  | { phase: "ok"; result: UsageResult }
  | { phase: "error"; text: string }

export default Plugin.define({
  id: "opencode-go-usage.tui",
  setup(context) {
    const rpc = context.client.rpc(GoUsage)
    const [state, setState] = createSignal<ViewState>({ phase: "loading" })
    const [now, setNow] = createSignal(Date.now())

    const refresh = async () => {
      try {
        setState({ phase: "ok", result: await rpc.get() })
      } catch (error) {
        setState({ phase: "error", text: describeRpcError(error) })
      }
    }

    void refresh()
    const refreshTimer = setInterval(() => void refresh(), REFRESH_MS)
    const tickTimer = setInterval(() => setNow(Date.now()), TICK_MS)

    context.ui.slot({
      append: "sidebar.footer",
      render: () => <UsageBlock state={state()} now={now()} />,
    })

    return () => {
      clearInterval(refreshTimer)
      clearInterval(tickTimer)
    }
  },
})

function UsageBlock(props: { state: ViewState; now: number }) {
  const context = usePlugin()
  const muted = () => context.theme.text.muted

  if (props.state.phase === "loading") {
    return <text fg={muted()}>Go usage: loading…</text>
  }
  if (props.state.phase === "error") {
    return <text fg={muted()}>Go usage: {props.state.text}</text>
  }

  const stale = props.state.result.stale === true
  return (
    <box flexDirection="column">
      <UsageRow label="Rolling" window={props.state.result.usage.rolling} now={props.now} dim={stale} />
      <UsageRow label="Weekly" window={props.state.result.usage.weekly} now={props.now} dim={stale} />
      <UsageRow label="Monthly" window={props.state.result.usage.monthly} now={props.now} dim={stale} />
    </box>
  )
}

function UsageRow(props: { label: string; window: UsageWindow; now: number; dim: boolean }) {
  const context = usePlugin()
  const accent = () => (props.dim ? context.theme.text.muted : usageColor(props.window.percent))
  const percent = () => String(Math.round(props.window.percent)).padStart(3)
  return (
    <box flexDirection="row">
      <text fg={context.theme.text.muted}>{props.label.padEnd(9)}</text>
      <text fg={accent()}>{barSegments(props.window.percent)}</text>
      <text fg={accent()}>{`  ${percent()}%`}</text>
      <text fg={context.theme.text.muted}>{`  ${formatResetsIn(props.window.resetsAt, props.now)}`}</text>
    </box>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 3: Handle the two known typing risks (only if Step 2 fails)**

- If `rpc.get()` requires an explicit argument, call `rpc.get(undefined)`.
- If theme tokens are not `string`-typed for `fg`, wrap with `String(context.theme.text.muted)`.

Re-run `pnpm typecheck` after either change.

- [ ] **Step 4: Commit**

```bash
git add src/tui.tsx
git commit -m "feat: render Go usage bars in the sidebar footer"
```

---

### Task 5: Live smoke script

**Files:**
- Create: `scripts/smoke.ts`

**Interfaces:**
- Consumes: `createUsageService`, `UsageError` from `../src/service` (Task 2); `formatUsageRows` from `../src/usage` (Task 1).
- Produces: `pnpm smoke` — a developer-facing command. Nothing imports it.

- [ ] **Step 1: Write the script**

`scripts/smoke.ts`:

```ts
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
```

- [ ] **Step 2: Run the smoke script**

Run: `pnpm smoke`
Expected: prints three rows with live percentages and countdowns, e.g.:

```
OpenCode Go usage
Rolling  ████░░░░░░   40%  1h 13m
Weekly   ██████████   77%  6h 9m
Monthly  ██████░░░░   64%  7d 16h
```

The exact numbers/colors change over time; the shape must match. The key is read at runtime and is not written anywhere.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0 (tsx and `@types/node` cover `process`, `fs`, and top-level await).

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.ts
git commit -m "feat: add live usage smoke script"
```

---

### Task 6: Local integration verification (real OpenCode)

**Files:**
- Modify: `/Users/ionutale/.config/opencode/opencode.jsonc` (temporary — reverted or replaced in Task 8)
- Possibly modify: `src/index.ts` (only if credential extraction needs a fix)

**Interfaces:**
- Consumes: everything built so far.
- Produces: evidence that the server plugin loads, the RPC answers, and the sidebar renders; a text capture for the README.

- [ ] **Step 1: Back up the global config and add the local plugin**

```bash
cp /Users/ionutale/.config/opencode/opencode.jsonc /Users/ionutale/.config/opencode/opencode.jsonc.bak-go-usage
```

Edit `/Users/ionutale/.config/opencode/opencode.jsonc`: add `"/Users/ionutale/developer/opencode-go-usage-plugin"` to the **existing `plugin` array** (the same array that contains `superpowers@git+https://github.com/obra/superpowers.git`). That array is known to load in this setup. If the plugin does not appear after Step 3, move the entry into a new top-level `"plugins"` array instead and repeat.

- [ ] **Step 2: Restart the service**

```bash
opencode service restart
opencode service status
```

Expected: service healthy. Then check the log for plugin errors:

```bash
rg -i "opencode-go-usage|plugin" ~/.local/share/opencode/log/opencode.log | tail -30
```

Expected: no load errors mentioning the plugin path. If an error appears, fix the cause, commit (`fix: ...`), and restart again.

- [ ] **Step 3: Query the RPC over HTTP (server-side end-to-end)**

```bash
opencode api post /api/rpc/go-usage/get --data '{}'
```

Expected: an `output` object containing `usage.rolling.percent`, `usage.weekly.percent`, `usage.monthly.percent`, and `fetchedAt`.

- If the result is a `no_credential`/`unauthorized` error, credential extraction is wrong. Add a temporary log in `src/index.ts` printing only `Array.isArray(...)`, `typeof credential`, and `Object.keys(credential ?? {})` — never the value — restart, read the log, adjust `extractKey`, remove the log, re-run this step, and commit the fix.
- If the RPC is not found (`404` / unknown rpc), the server plugin did not load: re-check Step 1's config key, then re-check Task 3 registration.

- [ ] **Step 4: Visual verification in a real session**

Attempt a pty capture:

```bash
script -q /private/var/folders/j7/sjlw7b1579j821nvs72mph5h0000gn/T/opencode-go-usage.capture opencode -c
```

Run it in the background for ~8 seconds, then stop the `opencode -c` process (e.g. `pkill -f "opencode -c"`). Inspect the captured file for the sidebar rows (`rg "Rolling" /private/var/folders/.../opencode-go-usage.capture`). If capture is unusable (alt-screen escapes), ask the user to look at the running TUI in a session and confirm the three rows and colors; that confirmation satisfies this step.

Also sanity-check narrow-width behavior: if the terminal is narrow, rows may clip. Clipping is acceptable; a crash or layout explosion is not.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: <describe the actual fix>"   # only if a fix was needed
```

---

### Task 7: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the verified behavior and any capture from Task 6.
- Produces: the public-facing documentation used by Task 8's published repo.

- [ ] **Step 1: Write the README**

`README.md`:

````markdown
# opencode-go-usage-plugin

[OpenCode](https://opencode.ai) Go plan usage — rolling, weekly, and monthly —
as three color-coded bars in the session sidebar.

```text
Rolling  ████░░░░░░   40%  1h 13m
Weekly   ██████████   77%  6h 9m
Monthly  ██████░░░░   64%  7d 16h
```

The numbers come from the same official endpoint the console dashboard uses:
`GET https://opencode.ai/zen/go/v1/usage`. If the console says 40%, this plugin
says 40%.

## Requirements

- OpenCode V2
- An OpenCode Go subscription, connected with `/connect` → **OpenCode Go**
- About 36 columns of sidebar width for all three rows

## Install

```sh
opencode plugin add github:ionutale/opencode-go-usage-plugin
```

Or add it to the `plugins` list in your `opencode.json(c)` manually:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:ionutale/opencode-go-usage-plugin"],
}
```

The plugin has both a server part and a TUI part, so it appears automatically in
the sidebar footer when the sidebar is visible.

## What you see

| Row     | Window                                | Resets                              |
| ------- | ------------------------------------- | ----------------------------------- |
| Rolling | Short-term burst limit (~5h)          | Shortly after usage slows down      |
| Weekly  | Weekly allotment                      | At the start of the next week       |
| Monthly | Full monthly allotment for the plan   | At the start of the next month      |

- Bar and percentage color: **green < 50%**, **yellow 50–74%**, **red ≥ 75%**.
- Data refreshes every 30 seconds; the reset countdown ticks every 30 seconds.
- Percentages are *used* amounts, same as the console dashboard.
- If the API is unreachable, the last good values stay on screen (dimmed) for
  up to 5 minutes.

## How it works

```text
TUI (sidebar slot) ──RPC──▶ server plugin ──HTTPS──▶ opencode.ai /zen/go/v1/usage
```

- The **server plugin** resolves your Go credential through OpenCode's
  integration API, fetches the usage endpoint, and caches the result for 15
  seconds. Your API key never leaves the server process and is never logged.
- The **TUI plugin** calls the typed RPC method `get` (id `go-usage`) every 30
  seconds and renders `sidebar.footer`. It never sees your key.
- Because the fetch happens server-side, the widget also works when your CLI is
  connected to a remote server.

## Troubleshooting

| Sidebar shows            | Meaning                                             | Fix                                                        |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| `Go usage: not connected`| No OpenCode Go connection found                     | Run `/connect` and pick OpenCode Go                        |
| `Go usage: check API key`| The usage API rejected the key (HTTP 401)           | Re-run `/connect` with a fresh key from the console        |
| `Go usage: Go plan required` | The key has no Go subscription (HTTP 403)      | Subscribe to Go or use a different key                     |
| `Go usage: unreachable`  | Network/API problem with no usable cached data      | Retry shortly; check opencode.ai status                    |
| Dimmed numbers           | Showing the last successful fetch (up to 5 minutes) | Usually resolves on the next refresh                       |

## Development

```sh
pnpm install
pnpm test        # unit tests
pnpm typecheck   # tsc --noEmit
pnpm smoke       # live call; needs a local Go key (/connect or OPENCODE_API_KEY)
```

To test a local checkout in OpenCode, add its path to the `plugins` list of your
global `opencode.json(c)`, restart with `opencode service restart`, and open a
session. The RPC is also callable directly:

```sh
opencode api post /api/rpc/go-usage/get --data '{}'
```

## License

MIT © 2026 Ion Utale
````

- [ ] **Step 2: Verify the README claims**

Run each command shown in the README that applies locally (`pnpm test`, `pnpm typecheck`, `pnpm smoke`) and confirm the output matches the claims. If Task 6 produced a usable text capture, replace the preview block with the real capture, labeled as such.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

### Task 8: Publish to GitHub and install the published version

**Files:**
- Modify: `/Users/ionutale/.config/opencode/opencode.jsonc` (remove the local path, install the GitHub package)
- No source changes expected.

**Interfaces:**
- Consumes: the committed repo and the working GitHub CLI auth (`ionutale`, `repo` scope).
- Produces: public repo `github.com/ionutale/opencode-go-usage-plugin`, a `v0.1.0` tag, and the plugin installed for the user.

- [ ] **Step 1: Secret scan**

```bash
git grep -nE 'sk-[A-Za-z0-9]{20,}'
git ls-files | rg -i 'auth\.json|credential|secret|\.env'
```

Expected: no output from either command. If anything matches, remove it and amend history before pushing.

- [ ] **Step 2: Confirm the tree is clean and tests pass**

```bash
git status --short
pnpm test
pnpm typecheck
```

Expected: clean tree; tests and typecheck pass.

- [ ] **Step 3: Create the public repo and push**

```bash
gh repo create ionutale/opencode-go-usage-plugin --public --source=. --remote=origin --push \
  --description "OpenCode Go plan usage (rolling / weekly / monthly) as color-coded bars in the session sidebar"
gh repo edit --add-topic opencode --add-topic opencode-plugin --add-topic opencode-go --add-topic tui --add-topic usage
git tag -a v0.1.0 -m "v0.1.0"
git push --tags
```

Expected: repo URL printed; `gh repo view ionutale/opencode-go-usage-plugin --json url,visibility` shows `PUBLIC`.

- [ ] **Step 4: Install the published plugin for the user**

Remove the local path entry from the global `opencode.jsonc` `plugin` array (keep the backup file), then:

```bash
opencode plugin add github:ionutale/opencode-go-usage-plugin
opencode service restart
opencode api post /api/rpc/go-usage/get --data '{}'
```

Expected: the RPC returns live usage. Then ask the user to open a session and confirm the sidebar rows match the console. If `opencode plugin add` also writes the entry to `opencode.jsonc`, verify there is exactly one entry (not both the local path and the GitHub form).

- [ ] **Step 5: Report**

Post the repo URL, the install command, and the final verification results (RPC output, user confirmation). No commit is required for this task.

---

## Plan self-review notes

- **Spec coverage:** endpoint + auth (Task 1/2/3), RPC contract (Task 3), sidebar rendering + colors + countdowns + error/loading/stale states (Task 4 with pure logic in Task 1), caching and stale windows (Task 2), README (Task 7), publishing (Task 8), verification incl. secret scan (Tasks 6-8). Non-goals unchanged.
- **Constants** appear once in Task 1/Task 2 (pure modules) and once in Task 4 (timer names), matching the spec's exact values.
- **Type consistency:** `UsageWindow`/`UsageWindows`/`UsageResult`/`UsageError`/`GoUsage`/`ERROR_TEXT`/`extractKey` names are used identically across tasks.
