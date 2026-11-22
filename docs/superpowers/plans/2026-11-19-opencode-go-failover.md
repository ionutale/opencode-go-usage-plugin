# OpenCode Go Failover Implementation Plan

> **Historical plan.** This document built the original separate
> `opencode-go-failover` package. That repository no longer exists; the failover
> code now lives in `opencode-go-usage-plugin`. Use the root README for install
> and current behavior.

> **Updated 2026-11-19:** account choice now prefers the plan that renews soonest
> (headroom breaks ties), classification uses the host error taxonomy before
> message patterns, and waits clamp to the platform timer maximum. Where this
> plan differs, the spec is authoritative.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep OpenCode Go turns running by automatically switching the active Go credential when one account is near or at its usage limit.

**Architecture:** A server-only OpenCode v2 plugin. On prompt admission it compares every Go account's usage windows and activates a better one before the turn starts; on a limit failure it activates an available account and forces an immediate retry, or waits for the soonest window reset when none is available. Pure decision logic lives in `src/policy.ts` so it is unit-testable without the plugin context.

**Tech Stack:** TypeScript, `@opencode/plugin` ^2.3.2, vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-19-opencode-go-failover-design.md`

## Global Constraints

- Provider and integration ID: `opencode-go`. Usage endpoint: `https://opencode.ai/zen/go/v1/usage`.
- Usage response shape: `{ usage: { rolling | weekly | monthly: { status: string, percent: number, resetsAt: ISO } } }`.
- Plugin id: `opencode-go-failover`. Log prefix: `[go-failover]`.
- Never log, persist, or return an API key. Keys are used only as an `Authorization: Bearer` header.
- Config defaults: `proactiveThreshold: 90`, `hysteresisPoints: 10`, `usageCacheMs: 10000`, `waitBufferMs: 5000`, `notify: false`, `maxWaitMs: Infinity`, `credentialOrder: []`.
- Never switch on a non-limit error. Never throw out of a hook: a plugin bug must not block prompts or retries.
- Package scripts: `test` (`vitest run`), `typecheck` (`tsc --noEmit`). Package manager: pnpm.
- Repository layout mirrors `opencode-go-usage-plugin`: server entry exported straight from `src/index.ts`, no build step for the server part.

## Review Focus

1. One account's usage request failing (401, timeout) must not stop failover for the others.
2. A non-limit error (context overflow, 400, aborted turn) must not rotate accounts.
3. An exception inside either hook must be swallowed and logged, never propagated.
4. A turn must not rotate forever: at most one switch per account per turn.
5. Resets days away must produce a valid, clamped delay, never `NaN`, negative, or an oversized timer.
6. Missing `error.status` or an empty message must still be classified safely (no rotation unless it matches a limit pattern).

---

### Task 1: Repository scaffold and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`, `src/config.ts`, `src/config.test.ts`, `docs/superpowers/specs/2026-11-19-opencode-go-failover-design.md` (copy from the workspace), `docs/superpowers/plans/2026-11-19-opencode-go-failover.md` (copy from the workspace)

**Interfaces:**
- Produces: `type Config`, `const DEFAULTS: Config`, `function readConfig(options: Record<string, unknown> | undefined): Config`.

- [ ] **Step 1: Create the repository and scaffold**

```bash
cd ~/developer-playground
gh repo create ionutale/opencode-go-failover --private --description "Automatic OpenCode Go account failover" --clone
cd opencode-go-failover
pnpm init
pnpm add -D vitest typescript @types/node
pnpm add @opencode/plugin@^2.3.2
```

Then write `package.json` fields by hand:

```json
{
  "name": "opencode-go-failover",
  "version": "0.1.0",
  "description": "Automatic OpenCode Go account failover",
  "type": "module",
  "license": "MIT",
  "repository": "github:ionutale/opencode-go-failover",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "!src/*.test.ts"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@opencode/plugin": "^2.3.2" },
  "devDependencies": { "@types/node": "^26.6.3", "typescript": "^7.0.2", "vitest": "^5.0.2" }
}
```

`tsconfig.json` (same shape as the sibling plugin's): `target: "ES2022"`, `module: "preserve"`, `moduleResolution: "bundler"`, `lib: ["ES2022", "DOM"]`, `strict: true`, `noEmit: true`, `allowImportingTsExtensions: true`, `skipLibCheck: true`, `types: ["node"]`, `include: ["src", "vitest.config.ts"]`.

`vitest.config.ts`: `defineConfig({ test: { environment: "node" } })`.

`.gitignore`: `node_modules`, `.DS_Store`.

Copy the design doc and this plan into `docs/superpowers/specs/` and `docs/superpowers/plans/`.

- [ ] **Step 2: Write the failing test**

`src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { DEFAULTS, readConfig } from "./config"

describe("readConfig", () => {
  it("returns the documented defaults for undefined options", () => {
    expect(readConfig(undefined)).toEqual(DEFAULTS)
  })

  it("keeps valid overrides", () => {
    const config = readConfig({ proactiveThreshold: 75, hysteresisPoints: 5, notify: true, maxWaitMs: 60_000 })
    expect(config.proactiveThreshold).toBe(75)
    expect(config.hysteresisPoints).toBe(5)
    expect(config.notify).toBe(true)
    expect(config.maxWaitMs).toBe(60_000)
  })

  it("falls back for wrong types instead of throwing", () => {
    const config = readConfig({ proactiveThreshold: "90", usageCacheMs: -1, notify: "yes", credentialOrder: "Work" })
    expect(config.proactiveThreshold).toBe(90)
    expect(config.usageCacheMs).toBe(10_000)
    expect(config.notify).toBe(false)
    expect(config.credentialOrder).toEqual([])
  })

  it("accepts an explicit credential order and provider", () => {
    expect(readConfig({ credentialOrder: ["Work", "Personal"], provider: "acme" }).credentialOrder).toEqual([
      "Work",
      "Personal",
    ])
    expect(readConfig({ provider: "acme" }).provider).toBe("acme")
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm vitest run src/config.test.ts`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
export type Config = {
  provider: string
  credentialOrder: string[]
  proactiveThreshold: number
  hysteresisPoints: number
  usageCacheMs: number
  waitBufferMs: number
  notify: boolean
  maxWaitMs: number
}

export const DEFAULTS: Config = { /* the Global Constraints values */ }

export function readConfig(options: Record<string, unknown> | undefined): Config
```

Rules: `proactiveThreshold`/`hysteresisPoints`/`usageCacheMs`/`waitBufferMs` must be finite and `>= 0`, otherwise the default; `notify` must be a boolean; `credentialOrder` must be an array of non-empty strings; `provider` a non-empty string; `maxWaitMs` a finite number `>= 0` or `Infinity`.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold plugin with config parsing"
```

---

### Task 2: Usage API client

**Files:**
- Create: `src/usage.ts`, `src/usage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type UsageWindow = { status: string; percent: number; resetsAt: string }
export type UsageWindows = { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow }
export const USAGE_ENDPOINT: string
export class UsageParseError extends Error
export function parseUsageResponse(input: unknown): UsageWindows
export type UsageClient = {
  read: (account: { credentialID: string; key: string }, options?: { signal?: AbortSignal; fresh?: boolean }) => Promise<UsageWindows>
}
export function createUsageClient(options: { cacheMs: number; fetch?: typeof fetch; now?: () => number; endpoint?: string }): UsageClient
```

- [ ] **Step 1: Write the failing test**

`src/usage.test.ts` covers:

```ts
const SAMPLE = { usage: {
  rolling: { status: "ok", percent: 40, resetsAt: "2026-09-27T19:03:37.947Z" },
  weekly:  { status: "ok", percent: 77, resetsAt: "2026-09-28T00:00:00.000Z" },
  monthly: { status: "ok", percent: 64, resetsAt: "2026-10-05T10:02:18.000Z" },
} }

it("parses a valid response")                       // percent 40, weekly resetsAt preserved
it("rejects a missing window, string percent, invalid resetsAt")  // each throws UsageParseError
it("sends the key as a bearer token to the endpoint")             // fetch spy: URL + Authorization header
it("caches per credential until cacheMs elapses")                 // two reads, one fetch; third after clock advance fetches again
it("bypasses the cache when fresh is true")                       // second read with fresh: true fetches
it("throws on 401 without caching the failure")                   // read rejects; next read fetches again
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run src/usage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/usage.ts`**

Port the parser from `~/developer-playground/opencode-go-usage-plugin/src/usage.ts` (`parseUsageResponse`, `UsageParseError`) unchanged. The client is new: a `Map<credentialID, { windows: UsageWindows; at: number }>`, `fresh: true` skips the hit, non-2xx throws an `Error` that includes the status, request headers are `Authorization: Bearer <key>`, `Accept: application/json`, `User-Agent: opencode-go-failover/0.1.0`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts src/usage.test.ts
git commit -m "feat: add usage client with per-account cache"
```

---

### Task 3: Decision policy

**Files:**
- Create: `src/policy.ts`, `src/policy.test.ts`

**Interfaces:**
- Consumes: `UsageWindows` from Task 2.
- Produces:

```ts
export type Account = { credentialID: string; label: string }
export type Evaluated = Account & { usage: UsageWindows | undefined; state: "available" | "blocked" | "unknown"; headroom: number }
export function classifyLimitError(error: { type: string; message: string; status?: number }): boolean
export function evaluate(account: Account, usage: UsageWindows | undefined): Evaluated
export function chooseCandidate(input: {
  accounts: Evaluated[]
  activeID: string | undefined
  order: string[]
  hysteresisPoints: number
}): Evaluated | undefined
export function soonestReset(accounts: Evaluated[], nowMs: number): number | undefined   // ms from now
export function waitDelay(input: { accounts: Evaluated[]; nowMs: number; retryAfterMs?: number; bufferMs: number; maxWaitMs: number }): number
```

- [ ] **Step 1: Write the failing test**

`src/policy.test.ts`, with a `usage(rolling, weekly, monthly)` helper returning `UsageWindows` (all `status: "ok"` unless stated):

```ts
describe("classifyLimitError", () => {
  it("accepts 429")
  it("accepts limit-shaped types and messages", () => {         // type "provider.rate-limit", message "You have reached your usage limit"
    expect(classifyLimitError({ type: "provider.rate-limit", message: "" })).toBe(true)
    expect(classifyLimitError({ type: "unknown", message: "weekly limit reached" })).toBe(true)
  })
  it("rejects unrelated failures", () => {                      // 400 invalid request, empty message, undefined status
    expect(classifyLimitError({ type: "provider.invalid-request", message: "bad tool schema", status: 400 })).toBe(false)
    expect(classifyLimitError({ type: "unknown", message: "" })).toBe(false)
  })
})

describe("evaluate", () => {
  it("is available with headroom from the highest window")      // 40/77/64 -> headroom 23
  it("is blocked when a window percent is 100")                 // 100/10/10 -> blocked
  it("is blocked when a window status is not ok")               // status "exhausted" with percent 12 -> blocked
  it("is unknown without usage")                                // headroom 0
})

describe("chooseCandidate", () => {
  it("picks the greatest headroom, not the active account")     // active 23, others 60 and 30 -> 60
  it("prefers the earlier credentialOrder entry on a tie")
  it("returns undefined when the best gain is under hysteresis")// active headroom 88, best 92, hysteresis 10
  it("skips blocked and unknown accounts")
  it("returns undefined when the active account is the only available one")
})

describe("soonestReset", () => {
  it("returns the smallest positive reset across all windows")  // weekly in 2h beats monthly in 3d
  it("ignores past reset times")
  it("returns undefined when nothing is known")
})

describe("waitDelay", () => {
  it("uses the retryAfter floor when it is later than the reset")
  it("adds the buffer")
  it("clamps to maxWaitMs")
  it("never returns a negative or non-finite value")
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run src/policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/policy.ts`**

Classification regex: `/usage limit|quota|limit reached|rate limit|exceeded/i` against `type` and `message`, plus `status === 429`. `evaluate` treats `status !== "ok"` or `percent >= 100` as blocked. `chooseCandidate` considers `available` accounts except the active one, sorted by headroom desc then `order` index, and returns the best only when `best.headroom - activeHeadroom >= hysteresisPoints` (active missing or unknown counts as headroom 0). `waitDelay` returns `Math.min(max, Math.max(0, Math.max(delay, retryAfterMs ?? 0) + bufferMs))`, where `delay` is the `soonestReset` value or `0`; non-finite results clamp to `max`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts src/policy.test.ts
git commit -m "feat: add account selection and wait policy"
```

---

### Task 4: Account store over the plugin context

**Files:**
- Create: `src/accounts.ts`, `src/accounts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type Account = { credentialID: string; label: string }   // re-exported from policy.ts
export type AccountStore = {
  list: () => Promise<Account[]>
  activeID: () => Promise<string | undefined>
  key: (account: Account) => Promise<string | undefined>
  activate: (credentialID: string) => Promise<void>
}
export type AccountContext = {
  integration: {
    get: (input: { integrationID: string }) => Promise<{ data: { connections?: ReadonlyArray<unknown> } }>
    connection: { active: (integrationID: string) => Promise<unknown>; resolve: (connection: unknown) => Promise<unknown> }
  }
  credential: { activate: (input: { credentialID: string }) => Promise<void> }
}
export function createAccountStore(ctx: AccountContext, provider: string): AccountStore
```

- [ ] **Step 1: Write the failing test**

`src/accounts.test.ts` with a fake context whose `get` returns `{ data: { connections: [{ type: "credential", id: "cred_1", label: "Work", method: "key" }, { type: "credential", id: "cred_2", label: "Personal", method: "key" }, { type: "env", name: "OPENCODE_API_KEY" }] } }`:

```ts
it("lists only credential connections")
it("reads the active credential id")            // active() -> { type: "credential", id: "cred_1" }
it("returns undefined when the active connection is env-based")
it("resolves a key from either a string or a { key } object")
it("returns undefined when resolve returns nothing")
it("calls credential.activate with the given id")
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run src/accounts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/accounts.ts`**

Filter `connections` by `type === "credential"` and a string `id`; read `label` with the id as fallback. Extract a key from `string` or `{ key, apiKey, value }` (same helper shape as the sibling plugin's `extractKey`). `activeID` returns the `id` only when the active connection has `type === "credential"`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/accounts.ts src/accounts.test.ts
git commit -m "feat: enumerate and resolve Go credentials"
```

---

### Task 5: Hook wiring

**Files:**
- Create: `src/index.ts`, `src/index.test.ts`

**Interfaces:**
- Consumes: `readConfig`, `createUsageClient`, `createAccountStore`, and every `policy` export.
- Produces: default export `Plugin.define({ id: "opencode-go-failover", setup })`.

Relevant event shapes (from the spec):

```ts
// ctx.session.hook("retry", cb, { providerID }) callback event
{ sessionID: string; agent: string; model: { providerID: string; id: string }; error: { type: string; message: string; status?: number; retryAfterMs?: number }; attempt: number; decision: { retry: false } | { retry: true; delay: number } }
```

- [ ] **Step 1: Write the failing test**

`src/index.test.ts` with a fake context that records hooks (`session.hook(name, cb, options)`), returns the account store data from Task 4's fake, stubs `fetch` with per-key usage payloads, and a mutable `active` variable updated by `credential.activate`:

```ts
it("registers a provider-scoped retry hook")
it("rotates to the account with the most headroom on a limit error")   // active Work at 100%, Personal at 20% -> activate cred_2, decision { retry: true, delay: 0 }
it("leaves the decision alone for a non-limit error")                   // 400 -> no activate, decision untouched
it("waits for the soonest reset when every account is blocked")         // all 100%, weekly resets in 2h -> delay ≈ 2h + 5000
it("does not rotate twice to the same account within one turn")         // two attempts, second call activates cred_3 or leaves decision
it("switches on prompt admission above the threshold")                  // proactiveThreshold 10, active 40% -> activate the best account
it("does nothing proactively when the active account is below the threshold")
it("never throws when usage lookups fail")                              // fetch rejects -> hook resolves, no activate
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run src/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/index.ts`**

`setup(ctx)`:
1. `const config = readConfig(ctx.options)`.
2. Build `store`, `usage`, `log` (`[go-failover]` prefix, `console.log`/`console.error`).
3. Module-level `const inFlight = new Map<string, Set<string>>()` keyed by `sessionID` recording credential IDs already tried this turn; clear the entry when a prompt is admitted for that session.
4. `ctx.session.hook("prompt", async () => { try { await proactive() } catch (error) { log(...) } })`.
5. `ctx.session.hook("retry", async (event) => { try { await reactive(event) } catch (error) { log(...) } }, { providerID: config.provider })`.

`proactive()`: read accounts and usage; `evaluate` each; find `activeID`; call `chooseCandidate`; return immediately when nothing is chosen; otherwise `store.activate(chosen.credentialID)`, log `switched <from> -> <to> (<n>% -> <m>%)`.

`reactive(event)`: return when `!classifyLimitError(event.error)`; read accounts and usage with `fresh: true`; mark the active ID as tried; `chooseCandidate` over untried accounts; on a candidate, activate, log, set `event.decision = { retry: true, delay: 0 }`; otherwise compute `waitDelay` and set `{ retry: true, delay }`, logging the reset time. If no usage is available for any account (degraded mode), pick the next account in preference order that has not been tried and activate it with `delay: 0`.

`notify`: when true, `ctx.session.synthetic({ sessionID: event.sessionID, text: ... })` for reactive switches and waits, wrapped in its own `try/catch`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: wire proactive and reactive failover hooks"
```

---

### Task 6: Live verification and install

**Files:**
- Modify: `~/.config/opencode/opencode.jsonc` (add the plugin; back up first)
- Create: `README.md` (install, behaviour, options table, how to see the log)

**Interfaces:**
- Consumes: the built plugin.

- [ ] **Step 1: Verify inactive credentials resolve (decides full vs degraded mode)**

With the plugin installed, set `proactiveThreshold: 1` and send a prompt. Expected: a `[go-failover]` log line naming the switch, and `opencode api get /api/credential` shows a different `active: true`. If the log says keys could not be resolved, record the degraded path and confirm the switch still happens (blind rotation).

- [ ] **Step 2: Verify activation reaches the request**

Read `https://opencode.ai/zen/go/v1/usage` for each credential before and after a one-line prompt, with the plugin switching accounts. Expected: the new account's rolling percent increases, the old one's does not. If it does not, add an `http.request` hook that sets `Authorization` to the chosen account's key and re-run.

- [ ] **Step 3: Verify proactive does not disturb a running turn**

While a turn is streaming, send nothing; confirm no switch log appears mid-turn, and that a new prompt under the threshold does not switch.

- [ ] **Step 4: Verify a long wait**

Set `credentialOrder` to a single account and `proactiveThreshold: 0`, force all accounts to look blocked by stubbing `http.response` in a scratch branch, and confirm the retry waits for the computed reset instead of failing immediately. Record the observed behaviour if the retry cap ends the wait early.

- [ ] **Step 5: Write the README**

Install (`opencode plugin add github:ionutale/opencode-go-failover` or the `plugins` entry), the options table from the spec, log format, degraded-mode note, and a "what it never does" list (no non-limit switching, no secrets in logs).

- [ ] **Step 6: Commit and push**

```bash
git add -A
git commit -m "docs: document installation and behaviour"
git push -u origin main
```

---

## Self-Review

- Spec coverage: G1 → Task 5 reactive + Task 6 Step 2; G2 → Task 5 proactive + Task 6 Steps 1, 3; G3 → Task 3 `waitDelay` + Task 6 Step 4; G4 → Task 6 install. Account model → Tasks 2, 3, 4. Degraded mode → Task 4 (`key` may return undefined) + Task 5 fallback + Task 6 Step 1. Config table → Task 1. Logging → Task 5. Failure modes → Review Focus and Tasks 3, 5.
- Type consistency: `Account` is declared in `src/policy.ts` and re-exported by `src/accounts.ts`; `Evaluated.usage` is `UsageWindows | undefined` throughout; `chooseCandidate` always receives `Evaluated[]`.
- Review Focus: each line has a test in Task 3 or Task 5 (one-account failure and empty-message classification in Task 3; hook exceptions, rotation cap, and clamp in Tasks 3 and 5).
