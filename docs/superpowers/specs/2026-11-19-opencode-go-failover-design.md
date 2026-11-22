# OpenCode Go account failover — design

Date: 2026-11-19
Status: draft, awaiting approval

## Intent and why

Multiple OpenCode Go accounts are saved as credentials for the `opencode-go`
integration, one of them active. Each account has
its own rolling (5 hour), weekly, and monthly usage windows, verified against
`https://opencode.ai/zen/go/v1/usage`.

Today a turn fails as soon as the active account hits a limit, even when the
other two accounts have plenty of headroom. The point of this plugin is to keep
work moving: switch the active Go credential automatically, before a wall when
possible and immediately after a failure otherwise, and hold the turn when no
account can serve it until a window reopens.

## Goals

- **G1 Reactive failover.** When an `opencode-go` request fails with a limit
  error, activate the next Go credential that still has headroom and retry the
  same request inside the same turn.
- **G2 Proactive switching.** Before an account gets blocked, switch away from
  it once a usage window crosses a configurable threshold (default 90%), so
  turns rarely fail at all.
- **G3 Hold when everything is blocked.** When all accounts are blocked, keep
  the turn waiting until the soonest window reset, then continue.
- **G4 Zero-friction install.** Works with the existing credentials; the only
  configuration change is adding the plugin to `opencode.jsonc`.

## Non-goals

- A general multi-provider router. No fallback to Anthropic, OpenRouter, or the
  local Ollama provider.
- TUI, GUI, or sidebar work. `opencode-go-usage-plugin` already shows usage.
- Adding, editing, or validating credentials; key management stays in OpenCode.
- Cost optimisation between accounts beyond "who has headroom".

## Anti-goals

- Never switch on errors that are not limit errors. A 400, an aborted turn, or a
  tool failure must not rotate accounts.
- Never leave a session silently stuck: every decision writes one log line.
- Never flap. Switching must need a meaningful improvement in headroom, not a
  one-percent difference.
- Never hammer the usage endpoint. Cache reads and collapse concurrent checks.

## Constraints

- OpenCode v2 plugin API, `@opencode/plugin` (the installed server is v2.3.0;
  the plugin declares `^2.3.2` like the neighbouring plugin).
- The retry hook is `ctx.session.hook("retry", cb, { providerID: "opencode-go" })`
  and receives `{ sessionID, agent, model, error: { type, message, status? },
  attempt, decision }`. It may turn a terminal failure into a retry and may set
  the delay.
- OpenCode keeps a hard maximum attempt count. A very long wait may be
  terminated by it; this must be verified, not assumed (see Verification).
- `ctx.credential` exposes only `activate`, so the plugin cannot list
  credentials directly. It can still enumerate them through
  `ctx.integration.get({ integrationID })`, whose `Integration.Info.connections`
  carries `{ type: "credential", id, label, method }` for every saved key, and
  `ctx.integration.connection.resolve(connection)` takes any `Connection.Info`
  and returns its credential value. Reading every account's key this way is the
  first thing to verify; if the server only resolves the active connection, the
  plugin degrades to blind rotation (see Failure modes).
- `ctx.credential.activate({ credentialID })` changes the active credential
  globally, not per session.
- The retry event also carries `error.retryAfterMs`, which the plugin uses as a
  floor when computing a wait.
- Provider settings do not embed the API key (`/api/provider/opencode-go` has no
  `apiKey`), so the key appears to be resolved per request. If activation does
  not reach the retried request, the fallback is rewriting the `Authorization`
  header in `ctx.session.hook("http.request", ...)`.
- Usage response shape: `{ usage: { rolling | weekly | monthly: { status,
  percent, resetsAt } } }`.
- The plugin runs in the OpenCode server; there may be one instance per
  location. Shared in-flight state is guarded by a module-level singleton, and
  the design avoids background timers so instances never race each other.

## Approaches considered

1. **Reactive only.** Act only when a request fails. Simplest, no polling, no
   churn, but the failing turn pays a failed attempt and can still die if the
   retry cap is reached.
2. **Reactive + proactive (chosen).** A check at each turn boundary moves off an
   account before it blocks; the retry hook covers the residual cases
   (threshold too high, a single turn burning more than the remaining window).
   Chosen because the user asked for both, and because proactive switching is
   what makes the feature invisible in practice.
3. **Load balancing.** Always route to the account with the lowest usage. Best
   total throughput across three accounts, but constant switching noise and
   harder to reason about. Rejected in favour of a sticky account ordered by the
   plan renewal date: it spends the window that would otherwise expire unused
   without moving on every request.

## How it works

### Account model

Accounts are discovered from `ctx.integration.get({ integrationID: provider })`:
every entry in `connections` with `type: "credential"` is an account, keyed by
its `id`, labelled by its `label`. Its key comes from
`ctx.integration.connection.resolve(connection)` and is used only to poll usage;
keys are never logged, stored, or written anywhere.

For each account: `{ credentialID, label, state, headroom, renewalAt }`.

- `state`: `available` when every window reports `status: "ok"` and
  `percent < 100`; otherwise `blocked`.
- `headroom`: `min(100 - percent)` across rolling, weekly, and monthly — the
  window that will block first.
- `renewalAt`: the monthly window's `resetsAt` — the plan renewal. The account
  whose renewal comes first is preferred, so its remaining quota is spent before
  it renews. Rolling and weekly resets are far too frequent to order accounts by.
- `resetsAt`: per window, used to compute the soonest moment an account can
  serve requests again.

Preference order defaults to the order credentials are stored; an explicit
`credentialOrder` option can override it (by label or credential ID).

### Proactive switching (G2)

Evaluated once at each turn boundary, in the hook that admits a user prompt
(`ctx.session.hook("prompt", ...)`), never on a timer:

1. Refresh usage for all accounts (cache `usageCacheMs`; a cached read is
   acceptable here because the reactive path is the authoritative one).
2. Leave everything alone when `proactiveThreshold` is 0 or when only one
   account exists.
3. Otherwise pick the earliest-renewing `available` account whose monthly usage
   is below `proactiveThreshold` (default 90) and whose headroom across every
   window is at least `minHeadroom` (default 10). Include the active account in
   that comparison; if it is the best eligible account, there is nothing to do.
4. Activate the selected account when it is not the active. Do not require a
   headroom gain: a sooner-renewing account with less headroom must win. A
   temporary weekly or rolling block bridges to the next eligible account; the
   following prompt re-selects the earliest account after its window resets. Log
   the switch with the monthly percentage and the renewal countdown.

Doing this at prompt admission rather than on a background interval is
deliberate: it cannot disturb a turn that is already streaming, it needs no
cross-process coordination, and it needs no activity tracking. A turn that
starts under the threshold and later blocks the account is handled by the
reactive path, which is exactly the case the retry hook exists for.

### Reactive failover (G1)

`ctx.session.hook("retry", handler, { providerID: "opencode-go" })` runs after
OpenCode classifies a failure and before a retry is scheduled. The handler:

1. Classifies the failure using the host's taxonomy first: `provider.go-limit`
   and `provider.quota` are limit errors whatever their HTTP status, and 429/402
   are limit errors whatever their type. `provider.invalid-request`,
   `provider.budget-limit`, `provider.model-budget-limit`, `provider.free-limit`,
   `provider.content-filter`, `provider.auth`, and `provider.transport` never
   rotate: no credential switch can fix them. Only then does a message pattern
   (`usage limit`, `quota`, `rate limit`, `limit reached`, `limit exceeded`,
   `allowance`) act as a fallback for untyped failures, excluding request-shaped
   messages such as context length, output tokens, and payload size. Anything
   else returns without touching `decision`.
2. Refreshes usage (bypassing the cache; this is the authoritative signal).
3. If an `available` account exists, activates the one whose `renewalAt` is
   earliest (headroom then preference order break ties), sets
   `decision = { retry: true, delay: 0 }`, logs `rotated <from> -> <to> (<pct>
   -> <pct>)`, and returns.
4. If nobody is available, computes the soonest `resetsAt` across all windows of
   all credentials, sets `decision = { retry: true, delay: max(timeUntilReset,
   error.retryAfterMs ?? 0) + waitBufferMs }`, logs the reset time, and returns
   (G3). `maxWaitMs` clamps the delay when it is finite.
5. When the retry wakes up, the handler runs again: if a window has reopened it
   activates the best account and retries immediately; otherwise it waits for
   the next reset. If every account was already tried this turn and no blocking
   window has a pending reset, the error is left to surface instead of retrying
   on a buffer-only delay. The built-in attempt cap is the outer bound; when it
   is hit OpenCode surfaces its own error, which is acceptable because the plugin
   has logged every step.

### Sticky behaviour

The plugin does not rotate back to a preferred account when a window resets. The
active account stays until it crosses the threshold or blocks. This keeps
switching to a minimum and makes the current account predictable.

### Logging and visibility

One line per decision to the OpenCode server log, prefixed
`[go-failover]`. Session notifications are off by default (`notify: false`);
when enabled, a `ctx.session.synthetic` message announces a reactive switch or a
long wait. Synthetic messages are used deliberately: they do not run prompt
hooks and cannot start a model turn.

## Configuration

Passed through the plugin's `options` object in `opencode.jsonc`. The provider,
usage endpoint, and log path are fixed and no longer configurable:

| Option | Default | Meaning |
| --- | --- | --- |
| `credentialOrder` | `[]` | Preferred order, by label or credential ID; used only for ties |
| `proactiveThreshold` | `90` | Drain each account's monthly quota to this percentage before moving to the next; `0` disables proactive switching |
| `minHeadroom` | `10` | Do not switch into an account with less than this much headroom across any window |
| `usageCacheMs` | `10000` | Cache lifetime for usage reads |
| `waitBufferMs` | `5000` | Added to a window reset before retrying |
| `notify` | `false` | Post a synthetic session message on switch or long wait |
| `maxWaitMs` | `300000` | Maximum wait before the error is handed back to OpenCode |

## Failure modes

- **Usage endpoint unreachable or rejects the key.** Reactive path: rotate to the
  next credential in preference order anyway, at most three switches per turn,
  then stop rotating and let the error surface. Proactive path: skip this round.
- **Inactive credentials cannot be resolved.** Some builds may resolve only the
  active connection. Then the plugin degrades gracefully: it keeps IDs and
  labels, rotates blind on a limit error (activate the next credential in
  preference order, then poll usage to confirm it has headroom), and the
  proactive check compares only what it can measure. Same feature, one extra
  round trip in the worst case. Logged once at startup.
- **Key cannot be resolved for a credential.** Treat that credential as
  unavailable; log once.
- **Concurrent sessions fail at the same time.** A module-level mutex makes the
  selection single-flight; each retry re-reads which credential is active, so a
  second session does not rotate twice.
- **Two OpenCode servers running** (for example the TUI and the desktop
  service). There is no background loop, so no lease and no polling race; each
  process decides only when it is about to send a request. A credential
  activated by one process is visible to the other at its next request. Worst
  case both rotate once; `credential.activate` is idempotent.
- **Long waits are dropped by the retry cap.** Fallback: when the retry hook is
  no longer consulted, schedule a resume — after the reset, send the session a
  prompt that continues the turn. Only built if verification shows the cap
  interferes.
- **Server restart while waiting.** The wait is lost; the log line from step 4
  records why. Accepted.
- **Only one Go credential saved.** The plugin becomes a no-op that logs.
- **The active credential is not one the plugin knows** (for example an
  `OPENCODE_API_KEY` environment key). Treat it as the current account and
  never match it by ID; rotation still works.

## Verification

1. **Unit tests** (vitest) over pure policy functions: error classification,
   availability, headroom, candidate choice by renewal and headroom floor,
   preference order, soonest-reset computation, wait clamp.
2. **Credential enumeration.** Confirm `integration.get` lists all three Go
   credentials and that `connection.resolve` returns a key for an *inactive*
   one. This decides whether the plugin runs in full mode or degraded mode, so
   it is the first thing built and checked.
3. **Activation reaches the request.** Activate a different credential, run a
   one-line turn, and confirm the new account's rolling percent increments while
   the previous account's does not. If it does not, switch to the
   `http.request` header-rewrite fallback before writing more code.
4. **Proactive switch.** Set `proactiveThreshold` to a value below the current
   usage, send a prompt, and confirm the log shows the switch and `/api/credential`
   reports the new active credential — with a turn already running, confirm it is
   untouched.
5. **Reactive switch.** Force a limit error on the active account (a deliberately
   exhausted test key or a stubbed 429 through `http.response`) and confirm the
   turn continues on another account without user input.
6. **Long wait.** Use a short real window (rolling resets on the hour) to confirm
   a multi-minute retry delay survives and the turn resumes after the reset.
7. **No-op checks.** A non-limit error does not rotate; a non-Go provider does
   not trigger the hook; one credential means no switching.

## Delivery

- New repository `github:ionutale/opencode-go-failover`, private or public as
  you prefer, with `package.json` exporting `.` from `src/index.ts`.
- Loaded by adding `"github:ionutale/opencode-go-failover"` to `plugins` in
  `~/.config/opencode/opencode.jsonc` (an existing backup of that file is kept
  before editing).
- Files: `src/index.ts` (plugin definition and hook wiring), `src/accounts.ts`
  (credential listing, active resolution, selection), `src/usage.ts` (client,
  parser, cache), `src/policy.ts` (pure decision functions), matching
  `*.test.ts`, `README.md`, `tsconfig.json`.

## Left to the builder

- Exact module boundaries inside `src/`, provided the pure policy stays
  testable without the plugin context.
- Log formatting and message wording.
- Test doubles for the plugin context.
- Whether to expose a manual "rotate now" command for debugging.
