# opencode-go-usage-plugin

[OpenCode](https://opencode.ai) Go plan usage — rolling, weekly, and monthly —
as three color-coded bars in the session sidebar, and as one status pill above
the composer in OpenCode Desktop.

```text
Rolling  ████░░░░░░   40%  1h 13m
Weekly   ████████░░   77%  6h 9m
Monthly  ██████░░░░   64%  7d 16h
```

The numbers come from the same official endpoint the console dashboard uses:
`GET https://opencode.ai/zen/go/v1/usage`. If the console says 40%, this plugin
says 40%.

## Requirements

- OpenCode V2
- An OpenCode Go subscription, connected with `/connect` → **OpenCode Go**
- For the terminal sidebar: about 34 columns of width for all three rows
- For the desktop pill: OpenCode Desktop with the plugin in your global
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

The plugin has a server part, a TUI part, and a desktop GUI part, so it appears
automatically in the sidebar footer when the sidebar is visible, and above the
composer in OpenCode Desktop.

## Token usage view moved in 0.3.0

The filterable token usage dashboard and quick view now live in the separate
[opencode-token-usage-dashboard](https://github.com/ionutale/opencode-token-usage-dashboard)
plugin. Install it alongside this plugin:

```sh
opencode plugin add github:ionutale/opencode-token-usage-dashboard
```

This plugin keeps the sidebar and the read-only `go-usage` RPC. The dashboard
uses that RPC for official quota bars and the burn forecast when both plugins
are installed. `/tokens` now belongs to the dashboard plugin; this plugin no
longer registers it.

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

## OpenCode Desktop

Desktop has no terminal sidebar, so the plugin renders a composer pill instead.
The pill shows the highest of the three windows:

```text
(status icon) Go 77%
```

Pick the pill to see one row per window, each with its own status icon and the
countdown to its reset. Colors follow the same thresholds: green < 50%, yellow
50–74%, red ≥ 75%. The highest window also colors the pill's own icon.

- The pill appears while a session is open, not on Home.
- It refreshes every 30 seconds; the countdowns tick every 30 seconds.
- If the API is unreachable, the last good values stay, and the menu title says
  `(cached)` for up to 5 minutes.
- Errors read `Go usage: not connected`, `Go usage: check API key`,
  `Go usage: Go plan required`, or `Go usage: unreachable`, same as the sidebar.

The desktop half is the `./gui-experimental` part, so it needs the plugin in your
global `opencode.json(c)`; the desktop app does not read `cli.json`. The GUI API
is experimental upstream and may change between OpenCode releases.

## How it works

```text
TUI (sidebar slot)      ──RPC──▶ server plugin ──HTTPS──▶ opencode.ai /zen/go/v1/usage
Desktop (composer pill) ──RPC──┘
```

- The **server plugin** resolves your Go credential through OpenCode's
  integration API, fetches the usage endpoint, and caches the result for 15
  seconds. Your API key is never exposed to the TUI and is never written to logs.
- The **TUI plugin** calls the typed RPC method `get` (id `go-usage`) every 30
  seconds and renders `sidebar.footer`. It never sees your key.
- The **desktop GUI plugin** calls the same RPC on the desktop app's own server
  and renders the composer pill. It never sees your key either.
- Because the fetch happens server-side, both widgets also work when your CLI is
  connected to a remote server.

Endpoint shipped in [anomalyco/opencode#16513](https://github.com/anomalyco/opencode/pull/16513).

## Troubleshooting

| Sidebar shows            | Meaning                                             | Fix                                                        |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| `Go usage: not connected`| No OpenCode Go connection found                     | Run `/connect` and pick OpenCode Go                        |
| `Go usage: check API key`| The usage API rejected the key (HTTP 401)           | Re-run `/connect` with a fresh key from the console        |
| `Go usage: Go plan required` | The key has no Go subscription (HTTP 403)      | Subscribe to Go or use a different key                     |
| `Go usage: unreachable`  | Network/API problem with no usable cached data      | Retry shortly; check opencode.ai status                    |
| Dimmed numbers           | Showing the last successful fetch (up to 5 minutes) | Usually resolves on the next refresh                       |

On desktop, if the pill never appears, open **Settings > Extensions > Plugins**.
The plugin is listed there with a switch for its GUI, and a plugin whose id
collides with one of the app's is listed as not loaded.

## Development

```sh
pnpm install
pnpm build:tui   # rebuild dist/tui.js after editing src/tui.tsx
pnpm build:gui   # rebuild dist/gui-experimental.cjs after editing src/gui.tsx
pnpm test        # unit tests
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

To test a local checkout in OpenCode, add its path to the `plugins` list of your
global `opencode.json(c)`, restart with `opencode service restart`, and open a
session. The RPC is also callable directly:

```sh
opencode api post /api/rpc/go-usage/get --data '{"input":{}}'
```

## License

MIT © 2026 Ion Utale
