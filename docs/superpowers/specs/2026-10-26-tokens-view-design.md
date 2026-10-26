# OpenCode Go Usage — `/tokens` Modal (Design)

- **Date:** 2026-10-26
- **Status:** Implemented in 0.2.0
- **Repo:** `github.com/ionutale/opencode-go-usage-plugin`
- **Target:** OpenCode V2 (`@opencode/plugin` 2.x; verified against CLI 2.1.4)

## Summary

Add a `/tokens` modal to the existing Go usage plugin. It shows the official
rolling / weekly / monthly Go quota bars, then a filterable local token table
per provider and model for the selected subscription window, with a pinned
grand total.

The existing sidebar widget is unchanged. The modal reuses the existing
server-side Go credential and `go-usage` RPC; it does not add a new server
endpoint and never exposes the API key to the terminal.

## Goals

1. Show input, output, reasoning, cache read, cache write, total, and steps per
   provider + model.
2. Default the table to the current anchored subscription month; offer rolling
   5h, current Go week, and all local history.
3. Make the relationship between official Go quota percentages and local token
   counts explicit.
4. Keep the modal keyboard-first, fast to open, and usable from home or a
   session.
5. Preserve the existing plugin's single-key, server-side credential design.

## Non-goals

- Server-side per-model Go usage history. The official API does not expose it.
- Per-API-key attribution. OpenCode records provider and model, not key ID.
- Cross-machine or cross-client aggregation.
- Billable cost accounting. The optional cost column is a list-price estimate.
- Notifications, exports, or a project filter.

## Verified constraints

- `GET https://opencode.ai/zen/go/v1/usage` returns only windows of
  `{ status, percent, resetsAt }`. It has no per-model token history.
- OpenCode's local `client.session.stats({ from, to, timezone, tools: "none" })`
  returns `models[]` with provider/model, variant, steps, tokens, and cost. It
  filters correctly when `from`/`to` are numeric epoch milliseconds. CLI check:
  last 24h returned 108 steps and 13.9M input tokens.
- The stats endpoint includes subagents and has no exclusion flag.
- `TokenUsage.total` is `input + output + reasoning + cache.read + cache.write`.
- Built-in slash commands `/usage` (workspace limits dialog) and `/stats` (usage
  poster) already exist. `/tokens` is free.
- The V2 dialog API supports `medium` (60 columns), `large` (88), and `xlarge`
  (116). `dialog.show()` calls `replace()`, which resets the size to `medium`;
  calling `dialog.set({ size: "xlarge", centered: true })` **after** `show()`
  applies the requested presentation.
- The package build script transforms only `src/tui.tsx`. JSX must stay in that
  file; pure logic belongs in `.ts` modules that Bun loads natively.

## Domain terms

| Term | Meaning |
| --- | --- |
| Go quota | Official server-side allowance percentage for rolling / weekly / monthly windows |
| Rolling | The last five hours |
| Week | The current Go week, derived from `weekly.resetsAt - 7d` |
| Month | The current subscription cycle, derived from `monthly.resetsAt` minus one calendar month |
| Local stats | OpenCode's session statistics for the connected server's database |
| Provider + model row | One table row after aggregating all variants of a model under a provider |
| Total | Sum of input, output, reasoning, cache read, cache write |
| Subagent | A child session; included in local stats |
| List-price cost | Estimated model cost, not the flat Go subscription charge |

## Architecture

```text
TUI
├─ sidebar.footer ── RPC go-usage/get ──▶ server plugin ── HTTPS ──▶ Go usage
└─ /tokens modal
   ├─ RPC go-usage/get ─────────────────▶ same quota result (15s server cache)
   └─ client.session.stats({from,to}) ──▶ local OpenCode session stats
```

- **Server plugin:** unchanged (`src/index.ts`, `src/rpc.ts`, `src/service.ts`).
- **TUI plugin:** registers `sidebar.footer` plus a global command
  `opencode-go-usage.tokens` (`palette: true`, `slash: { name: "tokens" }`).
- **Pure logic:** `src/tokens.ts` handles range math, variant aggregation,
  filtering, sorting, totals, and formatting.
- **JSX:** all modal components live in `src/tui.tsx` because of the build
  constraint above.
- **No direct SQLite.** The local stats API is the data source.

## Range math

`rangeWindow(key, usage, now)` returns `{ from?, to, approximate }`:

| Key | From | Notes |
| --- | --- | --- |
| `rolling` | `now - 5h` | `to = now + 1` |
| `week` | `Date.parse(usage.weekly.resetsAt) - 7d` | Fallback: start of ISO week in UTC |
| `month` | `subtractUtcMonth(Date.parse(usage.monthly.resetsAt))` | Fallback: start of calendar month in UTC |
| `all` | `undefined` | All local history |

- Month subtraction clamps at month end (e.g. Mar 31 → Feb 28/29).
- If the quota result is missing, stale, or has an invalid reset, the fallback
  is used and `approximate` is true.
- The range label appends `quota unavailable (fallback)`.
- The table query includes the current step via `to = now + 1`.

## UI

### Invocation

- Slash: `/tokens`
- Palette: **Go usage: tokens by model** (group **Go usage**)
- The modal is `xlarge` (116 columns) and centered, set after `dialog.show()`.

### Header

1. `Token usage` and `Updated HH:MM:SS`.
2. `Official Go quota (% of allowance)`.
3. Rolling / Weekly / Monthly bars with percentages and reset countdowns.
4. Range label with exact timestamps and timezone.
5. `Local stats · this OpenCode server only · includes subagents`.

If quota loading fails, the header shows `Go quota: <reason>`; the table still
loads using the fallback range.

### Filter bar

- Range tabs: `1 Rolling`, `2 Week`, `3 Month`, `4 All`.
- Provider: `p` cycles; default `opencode-go`.
- Model: `m` cycles; default `all`.
- Sort: `s` cycles metric; `S` reverses direction; default Total descending.
- Cost: `c` toggles; default off.
- Exact: `t` toggles; default off (compact numbers).

### Table

- One row per provider + model; variants aggregated.
- Raw provider/model IDs.
- Columns: Provider, Model, Input, Output, Reasoning, Cache R, Cache W, Total,
  Steps; optional Cost*.
- Numeric columns size to the widest formatted value in the current range, so
  exact mode never truncates a number.
- Optional columns are dropped, in order, until the table fits: Reasoning →
  Steps → Cache W → Cost. Provider, Model, Input, Output, Cache R, and Total
  are never dropped.
- Fixed table header; scrollable rows; pinned total footer.
- Table height shrinks to the row count (minimum five rows) and caps at the
  available modal height.

### Footer

- Separator and grand total for the visible filtered rows.
- Model count.
- `Cost*` footnote when cost is enabled: estimated list price, not the Go charge.
- Shortcut hint line:
  `1-4 range · p provider · m model · s sort · S direction · c cost · t exact · r refresh · Esc close`

### States

- Loading: `Gathering local usage…`
- Empty: hint to press `p` for all providers or `1-4` for another range.
- Stats error: message plus `Press r to retry.` The header stays visible.
- Quota error: warning plus fallback range; table still loads.
- Stale quota: dimmed bars.

### Refresh

- On open, on range change, and on `r`.
- No auto-refresh while the modal is open; the quota countdown still ticks.
- Filter changes (provider/model/sort/cost/exact) are client-side and do not
  refetch.
- Filters are remembered for the TUI session; a fresh TUI starts at Month +
  `opencode-go` + All + Total descending.

## Data source limitations

1. **Local only.** The table covers the connected OpenCode server's session
   database. Other machines and clients are not included.
2. **Provider-level, not per-key.** One Go key/workspace is assumed. Historical
   rows cannot be split by key.
3. **Official quota is percentage-only.** The table is context, not the
   server-side billing record.
4. **Subagents included.** No exclusion flag exists on the stats API.
5. **Variants aggregated.** The stats API returns variants separately; the view
   sums them per provider + model.
6. **Cost is list price.** The Go plan is flat; the cost column is not the
   subscription charge.
7. **Stats API is experimental.** Behavior is pinned by unit tests and graceful
   error handling.

## Rejected alternatives

- **Full-screen route:** the user chose a modal; xlarge is sufficient for the
  default column set.
- **Direct SQLite aggregation:** unnecessary now that the stats API filters by
  epoch time; avoids coupling to the internal DB schema.
- **Official Go history only:** no per-model history exists on the API.
- **Nested select dialogs for filters:** `dialog.select` replaces the modal;
  inline keyboard controls keep the view alive.
- **Separate token plugin:** duplicates the Go credential, RPC, sidebar, and
  packaging already in this plugin.
- **Project filter / custom dates:** out of scope for v1.

## Testing and verification

- Unit tests (`src/tokens.test.ts`): rolling/week/month/all ranges, month-end
  and leap-year clamping, quota-unavailable fallback, stale and expired resets,
  variant aggregation, provider/model filtering, sorting, totals, options,
  compact/exact formatting, cost formatting, range labels, malformed stats
  payloads, exact numeric column widths, and responsive column removal.
- `pnpm test`, `pnpm typecheck`, `pnpm build:tui`.
- Live pty verification at 120×40:
  - `/tokens` opens the xlarge modal.
  - Ctrl+P finds `Go usage: tokens by model`.
  - Default Month shows the anchored range, quota bars, per-model rows, and the
    pinned total.
  - `2` switches to the Go week; `c` adds the cost column; `t` shows exact
    numbers; `p` switches to all providers.
  - Escape closes and returns to the prompt.
- Post-release reinstall from GitHub and repeat the entry-point check.

## Release

- Version **0.2.0**.
- Update package description and README.
- Rebuild and commit `dist/tui.js`.
- Tag `v0.2.0` and push the public repo.
