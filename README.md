# opencode-go-usage-plugin

[OpenCode](https://opencode.ai) Go plan usage — rolling, weekly, and monthly —
as three color-coded bars in the session sidebar.

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
- About 34 columns of sidebar width for all three rows

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

## How it works

```text
TUI (sidebar slot) ──RPC──▶ server plugin ──HTTPS──▶ opencode.ai /zen/go/v1/usage
```

- The **server plugin** resolves your Go credential through OpenCode's
  integration API, fetches the usage endpoint, and caches the result for 15
  seconds. Your API key is never exposed to the TUI and is never written to logs.
- The **TUI plugin** calls the typed RPC method `get` (id `go-usage`) every 30
  seconds and renders `sidebar.footer`. It never sees your key.
- Because the fetch happens server-side, the widget also works when your CLI is
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
`src/tui.tsx`. (The script is deliberately not named `build`: OpenCode runs a
plugin's `build` script during package preparation, before its dependencies
are available.)

To test a local checkout in OpenCode, add its path to the `plugins` list of your
global `opencode.json(c)`, restart with `opencode service restart`, and open a
session. The RPC is also callable directly:

```sh
opencode api post /api/rpc/go-usage/get --data '{"input":{}}'
```

## License

MIT © 2026 Ion Utale
