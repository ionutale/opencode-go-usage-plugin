# opencode-go-usage-plugin

[OpenCode](https://opencode.ai) Go plan usage — rolling, weekly, and monthly —
as color-coded bars in the session sidebar, plus a `/tokens` modal with a
per-model local token breakdown.

```text
Rolling  ████░░░░░░   40%  1h 13m
Weekly   ████████░░   77%  6h 9m
Monthly  ██████░░░░   64%  7d 16h
```

The quota numbers come from the same official endpoint the console dashboard
uses: `GET https://opencode.ai/zen/go/v1/usage`. If the console says 40%, this
plugin says 40%.

## Requirements

- OpenCode V2
- An OpenCode Go subscription, connected with `/connect` → **OpenCode Go**
- About 34 columns of sidebar width for the three quota rows
- About 110 terminal columns for every `/tokens` column; narrower terminals
  hide optional columns

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

The plugin has both a server part and a TUI part, so the sidebar widget appears
automatically and `/tokens` is registered in the palette and prompt.

## What you see

| Row     | Window                              | Resets                                                                                 |
| ------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| Rolling | Short-term burst limit (~5h)        | Counts down to the API's reset time for the short-term window                          |
| Weekly  | Weekly allotment                    | Counts down to the weekly boundary                                                     |
| Monthly | Full monthly allotment for the plan | Counts down to your subscription's monthly reset (anchored — not the 1st of the month) |

- Bar and percentage color: **green < 50%**, **yellow 50–74%**, **red ≥ 75%**.
- Data refreshes every 30 seconds; the reset countdown ticks every 30 seconds.
- Percentages are *used* amounts, same as the console dashboard.
- If the API is unreachable, the last good values stay on screen (dimmed) for
  up to 5 minutes.

## Token usage view

Open it with `/tokens`, or press `Ctrl+P` and choose **Go usage: tokens by
model**. It is an `xlarge` modal with quota context, filters, a scrollable
table, and a pinned total.

```text
Token usage                                                     Updated 17:42
Official Go quota (% of allowance)
Rolling  ░░░░░░░░░░    4%  44m
Weekly   ░░░░░░░░░░    1%  6d 7h
Monthly  ███░░░░░░░   32%  22d 3h
Subscription month · Oct 17 at 21:43 → Oct 26 at 17:42 (Europe/Rome)
Local stats · this OpenCode server only · includes subagents
Range 1 Rolling 2 Week 3 Month 4 All
Provider [p] opencode-go · Model [m] all · Sort [s] Total ↓ · Cost [c] off · Exact [t] off
Provider     Model                              Input   Output Reasoning    Cache R    Cache W      Total  Steps
opencode-go  deepseek-v4.1-flash                61.9M     3.8M        7M       2.2B          0       2.2B 10,549
opencode-go  longcat-2.5-preview-free            180K    66.2K       154       3.1M          0       3.4M     31
────────────────────────────────────────────────────────────────────────────────────────────
Total        2 models                             62M     3.8M        7M       2.2B          0       2.2B 10,580
```

### Ranges

| Key | Range | Meaning |
| --- | --- | --- |
| `1` | Rolling | Last 5 hours |
| `2` | Week | Current Go week (anchored to the official weekly reset) |
| `3` | Month (default) | Current subscription cycle (the official monthly reset minus one month) |
| `4` | All | Every local session recorded by this OpenCode server |

`Week` and `Month` use the official reset timestamps. If the quota endpoint is
unavailable, they fall back to the start of the ISO week (UTC) or the calendar
month (UTC) and the range label says `quota unavailable (fallback)`.

### Table

- One row per provider + model. Model variants are aggregated into that row.
- Columns: provider, model, input, output, reasoning, cache read, cache write,
  total, steps; `Cost*` is optional.
- `Total` = input + output + reasoning + cache read + cache write, matching
  OpenCode's token accounting.
- The footer is pinned and sums the visible filtered rows.
- `t` switches between compact (`13.9M`) and exact (`13,920,000`) numbers.
- `c` shows an estimated list-price cost. It is **not** your Go subscription
  charge; the official quota bars are the subscription truth.

### Keys

| Key | Action |
| --- | --- |
| `1`–`4` | Rolling / Week / Month / All |
| `p` | Cycle provider |
| `m` | Cycle model |
| `s` | Cycle sort metric |
| `S` | Reverse sort direction |
| `c` | Toggle cost column |
| `t` | Toggle compact/exact numbers |
| `r` | Refresh quota + table |
| `Esc` | Close |
| arrows / PgUp / PgDn | Scroll the table |

The table refreshes when it opens, when the range changes, and with `r`. It
does not auto-refresh while open. Filters are remembered for the current TUI
session and reset when the TUI restarts.

### What the token table does and does not cover

- **Local:** it reads OpenCode's local session statistics for the server the CLI
  is connected to. Usage from other machines or clients (Pi, Claude Code, a
  Windows install) is not included.
- **Provider-level:** OpenCode records the provider (`opencode-go`) per request,
  not which API key or workspace handled it. The view assumes one Go key per
  workspace; multiple keys cannot be separated in historical rows.
- **Includes subagents.** The stats API has no switch to exclude them.
- **Variants are aggregated** per provider + model.
- The official Go API exposes only quota percentages and reset times for
  history; it has no per-model token history.

## How it works

```text
TUI (sidebar slot + /tokens) ──RPC──▶ server plugin ──HTTPS──▶ opencode.ai /zen/go/v1/usage
                                  └──▶ OpenCode session stats (local per-model tokens)
```

- The **server plugin** resolves your Go credential through OpenCode's
  integration API, fetches the usage endpoint, and caches the result for 15
  seconds. Your API key is never exposed to the TUI and is never written to
  logs.
- The **TUI plugin** calls the typed RPC method `get` (id `go-usage`) every 30
  seconds for the sidebar, and on demand for the quota header in `/tokens`. It
  never sees your key.
- The `/tokens` table calls OpenCode's local `client.session.stats` with the
  selected range. The API returns per-model tokens, steps, and an estimated
  list-price cost.
- Because the quota fetch happens server-side, the sidebar also works when your
  CLI is connected to a remote server. The token table follows the connected
  server's local session data.
- The xlarge presentation is set after `dialog.show`, because the V2 dialog API
  resets the size to `medium` during `replace`.

Endpoint shipped in [anomalyco/opencode#16513](https://github.com/anomalyco/opencode/pull/16513).

## Troubleshooting

| Sidebar shows            | Meaning                                             | Fix                                                        |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| `Go usage: not connected`| No OpenCode Go connection found                     | Run `/connect` and pick OpenCode Go                        |
| `Go usage: check API key`| The usage API rejected the key (HTTP 401)           | Re-run `/connect` with a fresh key from the console        |
| `Go usage: Go plan required` | The key has no Go subscription (HTTP 403)      | Subscribe to Go or use a different key                     |
| `Go usage: unreachable`  | Network/API problem with no usable cached data      | Retry shortly; check opencode.ai status                    |
| Dimmed numbers           | Showing the last successful fetch (up to 5 minutes) | Usually resolves on the next refresh                       |

If `/tokens` shows `quota unavailable (fallback)`, the token table still works;
the range is using the UTC calendar fallback. If the table itself fails, press
`r` to retry.

## Development

```sh
pnpm install
pnpm build:tui   # rebuild dist/tui.js after editing src/tui.tsx
pnpm test        # unit tests
pnpm typecheck   # tsc --noEmit
pnpm smoke       # live call; needs a local Go key (/connect or OPENCODE_API_KEY)
```

The published `./tui` entry is the prebuilt `dist/tui.js`, committed to the
repo. OpenTUI's Solid plugin does not compile JSX inside `node_modules`, so
packaged installs need this prebuilt file; run `pnpm build:tui` after editing
`src/tui.tsx`. All JSX lives in `src/tui.tsx` for that reason; pure token logic
lives in `src/tokens.ts`. (The script is deliberately not named `build`:
OpenCode runs a plugin's `build` script during package preparation, before its
dependencies are available.)

To test a local checkout in OpenCode, add its path to the `plugins` list of your
global `opencode.json(c)` and open `/tokens`. The RPC is also callable directly:

```sh
opencode api post /api/rpc/go-usage/get --data '{"input":{}}'
```

## License

MIT © 2026 Ion Utale
