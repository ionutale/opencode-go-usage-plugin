# opencode-go-usage-plugin

[OpenCode](https://opencode.ai) Go plan **usage** and automatic **account
failover**, in one plugin.

- **Usage** — rolling, weekly, and monthly quota in the terminal sidebar and as
  three activity rings in the OpenCode Desktop session header. Click the rings to
  see every saved Go credential at once.
- **Failover** — when the active credential nears its limit, or hits one, switch
  to the account whose plan renews soonest and keep the turn running.

Both halves share one server plugin, one install, and one set of options. The
failover code used to live in a separate repository; it is now part of this
package.

## Requirements

- OpenCode V2
- An OpenCode Go subscription, connected with `/connect` → **OpenCode Go**
- **Two or more** Go credentials for failover; with one, the failover half does
  nothing
- For the terminal sidebar: about 34 columns of width for all three rows
- For the desktop rings: OpenCode Desktop, with the plugin in your global
  `opencode.json(c)`

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

The plugin has a server part, a TUI part, and a desktop GUI part. The terminal
sidebar and the desktop rings appear automatically; no separate install step.

## What you see

### Terminal sidebar

```text
Rolling  ████░░░░░░   40%  1h 13m
Weekly   ████████░░   77%  6h 9m
Monthly  ██████░░░░   64%  7d 16h
```

| Row     | Window                              | Resets                                                                                 |
| ------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| Rolling | Short-term burst limit (~5h)        | Counts down to the API's reset time for the short-term window                          |
| Weekly  | Weekly allotment                    | Counts down to the weekly boundary                                                     |
| Monthly | Full monthly allotment for the plan | Counts down to your subscription's monthly reset (anchored — not the 1st of the month) |

- Bar and percentage color: **green < 50%**, **yellow 50–74%**, **red ≥ 75%**.
- Data refreshes every 30 seconds; the reset countdown ticks every 30 seconds.
- Percentages are *used* amounts, same as the console dashboard.
- If the API is unreachable, the last good values stay on screen (dimmed) for up
  to 5 minutes.

### OpenCode Desktop

Desktop has no terminal sidebar, so the plugin puts a small activity ring control
in the session header, first in the row that holds **Toggle session context**,
**Session details**, and **Toggle review**:

- Three concentric rings — rolling, weekly, monthly, outside in — fill with the
  active credential's percentages. Each ring is colored by its own usage:
  green < 50%, yellow 50–74%, red ≥ 75%.
- Hovering shows the three numbers; clicking opens **OpenCode Go usage**, a list
  of every Go credential you have saved.
- Each credential in the list shows its own three windows with the countdown to
  each reset, an **Active** badge, and its own error (`not connected`,
  `check API key`, `Go plan required`, `unreachable`) when a read fails. Every
  percentage is colored by its own usage with the same thresholds; one bad key
  never hides the others.
- The list refreshes every 30 seconds; countdowns tick every 30 seconds. Cached
  values are marked `cached` for up to 5 minutes.

The desktop half is the `./gui-experimental` part, so it needs the plugin in your
global `opencode.json(c)`; the desktop app does not read `cli.json`. The GUI API
is experimental upstream and may change between OpenCode releases.

## Automatic failover

**Before a turn** (prompt admission, never mid-turn): if the active account has
crossed the threshold, the plugin compares every Go account's usage and activates
the one whose plan renews soonest (the monthly reset), so capacity that would
otherwise expire unused is spent first. Greater headroom breaks a tie, and it
only switches when that is at least `hysteresisPoints` better, so it does not
flap between accounts. Sessions running on another provider are skipped.

**After a limit error** (a Go limit, 429/402, or a limit-shaped message): the
plugin re-reads usage, activates the available account whose plan renews soonest,
and asks OpenCode to retry the same request immediately. Each account is tried at
most once per turn.

A bare `429` is treated as a **rate limit**, not quota exhaustion: if the active
account's usage still shows headroom, the plugin leaves the retry delay to
OpenCode instead of rotating. Without this check, one rate-limit rejection turns
into a rotation storm — each retry is another request, often on a fresh key that
is limited in the same burst. A named Go/quota error rotates regardless, and
degraded mode (usage unavailable) still rotates blind.

**When every account is blocked**: the turn waits until an account can serve
again — until *every* blocking window on it has reset, not just the first one —
and then continues. If every account was already tried and no window reset is
pending, the error surfaces instead of a buffer-only retry.

### What it never does

- Switch on an error that is not a usage or Go limit (a 400, an aborted turn, a
  tool failure).
- Switch in the middle of a running turn.
- Throw an error into OpenCode: every failure inside a hook is caught and logged.
- Rotate more than once per account per turn.
- Touch any provider other than `opencode-go`.

### Failover limits

- If a usage window resets days away (a blocked weekly or monthly window), the
  turn waits that long; OpenCode's own retry attempt cap may end it first.
- If a credential's key cannot be read, that account is treated as unmeasured and
  the plugin rotates blind on a limit error, then re-checks.
- Usage percentages are coarse; the decisions are only as precise as they are.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "github:ionutale/opencode-go-usage-plugin",
      "options": {
        "proactiveThreshold": 90,
        "hysteresisPoints": 10,
        "credentialOrder": ["Work", "Personal"],
      },
    },
  ],
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `provider` | `"opencode-go"` | Integration and provider the failover half manages |
| `credentialOrder` | `[]` | Preferred order, by label or credential ID; ties use it |
| `proactiveThreshold` | `90` | Percent at which a new turn moves off the active account; `0` disables |
| `hysteresisPoints` | `10` | Minimum headroom gain required to switch |
| `usageCacheMs` | `10000` | Failover's own usage cache lifetime |
| `waitBufferMs` | `5000` | Added to a window reset before retrying |
| `maxWaitMs` | `Infinity` | Clamp for a single wait; `Infinity` always waits |
| `notify` | `false` | Post a short session message when the plugin switches or waits |
| `usageEndpoint` | `https://opencode.ai/zen/go/v1/usage` | Usage API; advanced/testing only |
| `logFile` | `~/.local/share/opencode/go-failover.log` | One line per failover decision |

The usage display ignores these options; it always polls the official endpoint.

## How it works

```text
TUI sidebar      ──RPC──┐
Desktop rings    ──RPC──┼──▶ server plugin ──HTTPS──▶ opencode.ai/zen/go/v1/usage
prompt / retry hooks ───┘         │
                                  └──▶ integration API: read keys, activate account
```

- The **server plugin** resolves Go credentials through OpenCode's integration
  API, fetches usage, and caches per credential for 15 seconds. Keys are used
  only as an `Authorization: Bearer` header and are never exposed to the TUI or
  the desktop app.
- The **TUI plugin** calls the typed RPC `get` (id `go-usage`) every 30 seconds
  and renders `sidebar.footer`.
- The **desktop GUI plugin** calls `getAll` for every credential and renders the
  header rings and the all-credentials list.
- The **failover hooks** run server-side, at prompt admission and on a limit
  retry, and activate a different credential through the integration API.
- Because the fetches happen server-side, both widgets also work when your CLI is
  connected to a remote server.

Endpoint shipped in [anomalyco/opencode#16513](https://github.com/anomalyco/opencode/pull/16513).

## Log

Failover decisions append one line to `~/.local/share/opencode/go-failover.log`:

```text
2026-11-19T18:58:06.098Z [go-failover] switched ahead of the limit (100% -> 5%): Personal (95 points of headroom, renews in 12d 6h)
2026-11-19T18:58:06.498Z [go-failover] rotated after a limit error: Work (76 points of headroom, renews in 5d 3h)
2026-11-19T18:58:06.498Z [go-failover] all accounts blocked, waiting 7200s for the next window
2026-11-21T18:32:51.000Z [go-failover] 429 at 33% looks like a rate limit, not quota; leaving the retry delay to OpenCode
```

API keys are never logged, stored, or written anywhere.

## Troubleshooting

| Shows | Meaning | Fix |
| --- | --- | --- |
| `Go usage: not connected` | No OpenCode Go connection found | Run `/connect` and pick OpenCode Go |
| `Go usage: check API key` | The usage API rejected the key (HTTP 401) | Re-run `/connect` with a fresh key from the console |
| `Go usage: Go plan required` | The key has no Go subscription (HTTP 403) | Subscribe to Go or use a different key |
| `Go usage: unreachable` | Network/API problem with no usable cached data | Retry shortly; check opencode.ai status |
| Dimmed numbers / `cached` | Showing the last successful fetch (up to 5 minutes) | Usually resolves on the next refresh |
| Failover does nothing | Fewer than two Go credentials, or you are on another provider | Add a second credential; failover only manages `opencode-go` sessions |

On desktop, if the rings never appear, open **Settings > Extensions > Plugins**.
The plugin is listed there with a switch for its GUI, and a plugin whose id
collides with one of the app's is listed as not loaded.

## Token usage view moved in 0.3.0

The filterable token usage dashboard and quick view now live in the separate
[opencode-token-usage-dashboard](https://github.com/ionutale/opencode-token-usage-dashboard)
plugin. Install it alongside this plugin:

```sh
opencode plugin add github:ionutale/opencode-token-usage-dashboard
```

This plugin keeps the sidebar, the header rings, and the read-only `go-usage`
RPC. The dashboard uses that RPC for official quota bars and the burn forecast
when both plugins are installed.

## Development

```sh
pnpm install
pnpm build:tui   # rebuild dist/tui.js after editing src/tui.tsx
pnpm build:gui   # rebuild dist/gui-experimental.cjs after editing src/gui.tsx
pnpm test        # 149 unit tests, including the failover half
pnpm typecheck   # tsc --noEmit
pnpm smoke       # live call; needs a local Go key (/connect or OPENCODE_API_KEY)
```

The published `./tui` entry is the prebuilt `dist/tui.js`, committed to the
repo. OpenTUI's Solid plugin does not compile JSX inside `node_modules`, so
packaged installs need this prebuilt file; run `pnpm build:tui` after editing
`src/tui.tsx`. (The script is deliberately not named `build`: OpenCode runs a
plugin's `build` script during package preparation, before its dependencies
are available.)

The published `./gui-experimental` entry is likewise the prebuilt
`dist/gui-experimental.cjs`. Desktop loads one CommonJS file and cannot load a
second chunk, so it is committed too; run `pnpm build:gui` after editing
`src/gui.tsx`. The bundle keeps `solid-js`, `@opencode/plugin/gui`, and
`@opencode/plugin/rpc` external, because the app provides its own copies.
`vitest.config.ts` keeps the unit tests in Node, away from the Solid plugin in
the GUI build config.

Failover code lives in `src/failover/`: `policy.ts` is the pure decision logic,
`accounts.ts` reads and activates credentials, `usage.ts` is its own cached
client, and `log.ts` writes the decision log. Its design and verification notes
are under `docs/`.

To test a local checkout in OpenCode, add its path to the `plugins` list of your
global `opencode.json(c)` and open a session. The RPCs are also callable
directly:

```sh
opencode api post /api/rpc/go-usage/get --data '{"input":{}}'
opencode api post /api/rpc/go-usage/getAll --data '{"input":{}}'
```

## License

MIT © 2026 Ion Utale
