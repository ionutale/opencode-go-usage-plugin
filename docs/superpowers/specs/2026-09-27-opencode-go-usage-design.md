# OpenCode Go Usage — Sidebar Footer Plugin (Design)

- **Date:** 2026-09-27
- **Status:** Design approved; implementation plan pending
- **Repo:** `github.com/ionutale/opencode-go-usage-plugin` (public, MIT)
- **Target:** OpenCode V2 (`@opencode/plugin` 2.x, tested against CLI v2.0.18)

## Summary

An OpenCode plugin that displays the OpenCode Go plan's usage as three
color-coded bars in the session sidebar footer:

```
Rolling  ████░░░░░░  40%  1h 13m
Weekly   ████████░░  77%  6h 9m
Monthly  ██████░░░░  64%  7d 16h
```

Data comes from the official usage endpoint `GET https://opencode.ai/zen/go/v1/usage`
(shipped 2026-08-11, anomalyco/opencode#16513), which returns the same
rolling / weekly / monthly numbers as the OpenCode console dashboard.

## Goals

1. Always-visible (sidebar shown) usage for a user on the OpenCode Go plan.
2. Numbers and reset countdowns that match the console dashboard.
3. No credentials in the terminal process; the OpenCode server resolves the
   `opencode-go` credential and performs the upstream fetch.
4. Installable from the public GitHub repo by anyone with a Go subscription:
   `opencode plugin add github:ionutale/opencode-go-usage-plugin`.
5. A README good enough to explain, install, and troubleshoot the plugin
   without reading the source.

## Non-goals (v1)

- Notifications when usage crosses a threshold.
- Click-through / detail panel, or a `/usage` command.
- Other plans (Zen credits, BYOK providers) or multi-account support.
- Configurable options (interval, bar width, thresholds are constants).
- npm publishing (GitHub distribution only for v1).

## Verified constraints (as of 2026-09-27)

- Upstream endpoint, verified live with the account's Go key:

  ```json
  {
    "usage": {
      "rolling": { "status": "ok", "percent": 40, "resetsAt": "2026-09-27T19:03:37.947Z" },
      "weekly":  { "status": "ok", "percent": 77, "resetsAt": "2026-09-28T00:00:00.000Z" },
      "monthly": { "status": "ok", "percent": 64, "resetsAt": "2026-10-05T10:02:18.000Z" }
    }
  }
  ```

  - Auth: `Authorization: Bearer <GO_API_KEY>`; `200` on success.
  - `percent` is used percentage (0–100); `resetsAt` is a UTC ISO timestamp.
- The server exposes the `opencode-go` integration with an active credential
  connection (`/api/integration` verified). Plugins can resolve it with
  `ctx.integration.connection.active("opencode-go")` +
  `ctx.integration.connection.resolve(connection)`.
- TUI plugin slots include `sidebar.footer`; RPC (`Rpc.define`,
  `ctx.rpc.register`, `client.rpc(Definition)`) is the sanctioned way to
  expose server-side methods to plugins and clients.
- Package plugin entries: the `./tui` export of a plugin package is loaded by
  the CLI automatically when the package is configured in `opencode.json(c)`;
  discovered local plugins use `index.ts` + `tui.tsx` beside each other.
- Dev environment: Node v26, pnpm 12.6, no Bun/tmux installed locally;
  `@opencode/plugin@2.0.18` and `@opentui/*@0.5.12` are installable from npm
  for typechecking and tests.

## Architecture

```
┌─ TUI process ────────────────┐      ┌─ OpenCode server ──────────────────┐      ┌─ opencode.ai ───────┐
│ tui.tsx                      │ RPC  │ index.ts (server plugin)           │ HTTP │ /zen/go/v1/usage    │
│ • sidebar.footer slot        │─────▶│ • resolves opencode-go credential  │─────▶│ (Bearer key)        │
│ • polls every 30s            │ get  │ • fetches + 15s cache              │      │ rolling/weekly/     │
│ • ticks countdown locally    │◀─────│ • serves last-good on failure      │      │ monthly             │
└──────────────────────────────┘      └────────────────────────────────────┘      └─────────────────────┘
```

- **Server plugin** (`src/index.ts`): registers the RPC, resolves the Go
  credential, fetches the upstream endpoint, caches, maps failures to typed
  RPC errors.
- **RPC contract** (`src/rpc.ts`): shared `Rpc.define` definition imported by
  both entries. ID: `go-usage`.
- **TUI plugin** (`src/tui.tsx`): calls the RPC through `context.client`,
  renders the `sidebar.footer` slot, polls, ticks the countdown locally.
- **Pure logic** (`src/usage.ts`): parsing/validation, countdown formatting,
  bar/color mapping. No OpenCode imports, fully unit-testable.

The TUI talks only to the RPC. This keeps the API key server-side and makes
the widget work when the CLI is connected to a remote server.

## RPC contract

```ts
import { Rpc } from "@opencode/plugin/rpc"

export const GoUsage = Rpc.define({
  id: "go-usage",
  methods: {
    get: {
      // no input
      output: {
        type: "object",
        properties: {
          usage: {
            type: "object",
            properties: {
              rolling: WINDOW, weekly: WINDOW, monthly: WINDOW,
            },
            required: ["rolling", "weekly", "monthly"],
            additionalProperties: false,
          },
          fetchedAt: { type: "string" },   // ISO timestamp of the successful upstream fetch
          stale: { type: "boolean" },      // true when serving cached data after a failed refresh
        },
        required: ["usage", "fetchedAt"],
        additionalProperties: false,
      },
      errors: {
        no_credential: ERROR,
        unauthorized: ERROR,
        forbidden: ERROR,
        upstream: ERROR,
      },
    },
  },
})
```

- `WINDOW` = `{ type: "object", properties: { status: {type:"string"},
  percent: {type:"number"}, resetsAt: {type:"string"} }, required: [...],
  additionalProperties: false }`.
- `ERROR` data = `{ message: string }` (identical schema for all four).

Error mapping from upstream:

| Condition                                | RPC error        | TUI text            |
| ---------------------------------------- | ---------------- | ------------------- |
| Integration missing / no connection      | `no_credential`  | `not connected`     |
| HTTP 401                                 | `unauthorized`   | `check API key`     |
| HTTP 403                                 | `forbidden`      | `Go plan required`  |
| Network error, 5xx, parse error          | `upstream`       | `unreachable`       |

## Credential resolution

Server-side, per fetch attempt:

1. `const connection = await ctx.integration.connection.active("opencode-go")`;
   if absent → `no_credential`.
2. `const credential = await ctx.integration.connection.resolve(connection)`;
   extract the bearer secret; if absent → `no_credential`.

Fallbacks (only if step 2 proves not to yield the secret at implementation
time): the server may instead use `OPENCODE_API_KEY`, then the `opencode-go`
entry of `$XDG_DATA_HOME/opencode/auth.json` (default
`~/.local/share/opencode/auth.json`). The fallback must be recorded in the
implementation plan and README once chosen.

## Caching and failure behavior

Constants: `CACHE_TTL_MS = 15_000`, `STALE_MAX_AGE_MS = 300_000`.

- `get` returns the cached successful result when younger than 15s.
- Otherwise fetches upstream; on success updates the cache.
- On refresh failure with a cached result younger than 5 minutes: return the
  cached data with `stale: true`.
- On refresh failure with no usable cache: return the mapped RPC error.
- No background timers on the server; work happens only on `get`.

## Rendering specification

Slot: `context.ui.slot({ append: "sidebar.footer", render: ... })`.

Per window, one row: `<name>  <bar>  <pct>  <countdown>`

- `name`: `Rolling`, `Weekly`, `Monthly` (7 chars, no padding needed).
- `bar`: 10 segments; filled = `clamp(round(percent / 10), 0, 10)`;
  filled `█`, empty `░`.
- `pct`: rounded integer + `%`, e.g. `40%`.
- `countdown`: remaining time until `resetsAt`, computed from a local clock:
  - `≥ 1 day` → `Xd Yh` (e.g. `7d 16h`)
  - `≥ 1 hour` → `Xh Ym` (e.g. `1h 13m`, `6h 9m`)
  - `else` → `Xm` (e.g. `45m`; `0m` when under a minute)
  - Already past `resetsAt` → `0m` (next fetch will refresh it).
- Colors (bar + percent): green `< 50`, yellow `50–74`, red `≥ 75`.
  Names and countdowns use dim theme tokens.
- Loading state (first fetch, no data): single dim line `Go usage: loading…`.
- Error state: single dim line `Go usage: <text>` using the table above,
  retried every poll cycle.
- Stale state: rows rendered dimmed (no countdown replacement).

Update cadence (TUI):

- Fetch immediately on setup, then every 30s.
- Re-render countdown every 30s from the last successful response, without
  refetching.
- Both timers cleared in the plugin teardown function.

## Repo layout and packaging

```
opencode-go-usage-plugin/
├── src/
│   ├── rpc.ts         # Rpc.define contract (id: go-usage)
│   ├── usage.ts       # pure logic: parse upstream, format duration/bar/color
│   ├── index.ts       # server plugin (credential, fetch, cache, errors)
│   ├── tui.tsx        # TUI plugin (sidebar.footer, polling, rendering)
│   └── usage.test.ts  # vitest unit tests
├── scripts/
│   └── smoke.ts       # live smoke test (reads key from auth.json at runtime)
├── docs/superpowers/specs/2026-09-27-opencode-go-usage-design.md
├── README.md
├── LICENSE            # MIT, © 2026 Ion Utale
├── package.json
├── tsconfig.json
└── .gitignore
```

`package.json` (shape per OpenCode plugin docs):

```json
{
  "name": "opencode-go-usage-plugin",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
    "./rpc": "./src/rpc.ts"
  },
  "files": ["src"],
  "dependencies": { "@opencode/plugin": "latest" },
  "peerDependencies": {
    "@opentui/core": ">=0.5.8",
    "@opentui/solid": ">=0.5.8",
    "solid-js": ">=1.9.0"
  },
  "devDependencies": {
    "@opentui/core": "^0.5.12",
    "@opentui/solid": "^0.5.12",
    "solid-js": "^1.9.15",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "smoke": "tsx scripts/smoke.ts"
  }
}
```

- `tsconfig.json`: `strict`, `noEmit`, `jsx: "preserve"`,
  `jsxImportSource: "@opentui/solid"`, `module: "preserve"`/`moduleResolution:
  "bundler"`, `types: ["node"]`.
- `.gitignore`: `node_modules/`, `dist/`, `.DS_Store`, captures (`*.capture.txt`).

## README outline

1. Title + tagline + ASCII preview of the sidebar block.
2. **What it is**: usage of the OpenCode Go plan (rolling/weekly/monthly),
   matching the console dashboard, shown in the sidebar.
3. **Requirements**: OpenCode V2, OpenCode Go subscription connected via
   `/connect`.
4. **Install**: `opencode plugin add github:ionutale/opencode-go-usage-plugin`
   (plus manual `plugins` entry alternative).
5. **Usage**: what each row means; colors; update cadence.
6. **How it works**: short diagram (server resolves key → RPC → TUI renders);
   link to the upstream endpoint PR; note the key never leaves the server.
7. **Troubleshooting**: table for `not connected`, `check API key`,
   `Go plan required`, `unreachable`, stale data.
8. **Development**: pnpm install, test, typecheck, local install for testing,
   smoke script.
9. **License**: MIT.

## Testing and verification

1. **Unit (vitest)**
   - `parseUsage`: valid response; missing keys; wrong types; extra fields.
   - `formatDuration`: `45m`, `1h 13m`, `6h 9m`, `7d 16h`, sub-minute → `0m`,
     past timestamp → `0m`.
   - `barSegments` / color: 0, 49, 50, 74, 75, 100 boundaries, rounding.
   - Server logic with mocked `fetch`: auth header present; 15s cache hit;
     401/403/network mapping; stale fallback within 5 min; error when no
     cache.
2. **Typecheck**: `pnpm typecheck`.
3. **Live smoke**: `pnpm smoke` with the real key (read at runtime; never
   written to disk or repo). When no key is available it prints instructions
   and exits non-zero instead of failing obscurely.
4. **Local integration**: add the repo path to the global `opencode.jsonc`
   `plugins` entry temporarily; `opencode service restart`; confirm clean
   plugin load in `~/.local/share/opencode/log/opencode.log`; run the TUI in
   a pty (`script -q <file> opencode -c`) and inspect the captured sidebar
   region; remove the temporary entry (or switch to the GitHub form after
   publish).
5. **Secret scan before publish**: `git grep -nE 'sk-[A-Za-z0-9]{20,}'`
   returns nothing; verify no `auth.json` copies exist in the repo.
6. **Post-publish install**: `opencode plugin add
   github:ionutale/opencode-go-usage-plugin`, restart service, verify the
   sidebar renders in the user's terminal.

## Publishing

- `git init` (branch `main`), conventional commits:
  `chore: repo scaffold`, `feat: ...`, `test: ...`, `docs: ...`.
- `gh repo create ionutale/opencode-go-usage-plugin --public --source .
  --push` with description
  `OpenCode Go plan usage (rolling / weekly / monthly) in the session sidebar`,
  topics: `opencode`, `opencode-plugin`, `tui`, `usage`, `go`.
- Never commit credentials; scan before push (see above).

## Acceptance criteria

1. With a Go plan connected, the sidebar footer shows three rows with bars,
   percentages, and countdowns matching `/zen/go/v1/usage` within one poll
   cycle.
2. Countdown text updates every ~30s without refetching; data refetches every
   ~30s.
3. With no connection / bad key / no subscription / offline, the widget shows
   the mapped dim one-liner instead of crashing or logging noisily.
4. The widget works when the TUI is connected to a remote server (key stays
   on the server).
5. `pnpm test` and `pnpm typecheck` pass; live smoke succeeds.
6. Repo is public on GitHub with README, MIT license, and no secrets; the
   plugin installs from the repo via `opencode plugin add` and renders for
   the author.

## Future ideas (explicitly deferred)

- Threshold notifications via `context.attention.notify`.
- `session.panel` detail view with a `/usage` slash command.
- RPC `updated` events pushed from a server-side refresh timer.
- npm publishing and configurable options.
