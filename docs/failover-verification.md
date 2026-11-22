# Verification notes

Date: 2026-11-19
Host: macOS, OpenCode 2.3.0 (TUI) / 2.3.2 server, multiple OpenCode Go
credentials saved.

## Verified live

- **Credential enumeration and key resolution.** With a local stub standing in for
  `https://opencode.ai/zen/go/v1/usage`, the plugin polled every saved account and
  the stub saw one distinct bearer key per account, so `integration.get` lists
  inactive credentials and `connection.resolve` returns their keys.
- **`credential.activate` reaches the next request.** After activating one
  account, the next `opencode-go` model request carried that account's key while
  another account was active before. Activation is not limited to the credential
  list.
- **Proactive switch, end to end.** With the stub reporting the active account at
  100% and the others at 5%, prompt admission logged
  `switched ahead of the limit (100% -> 5%)` followed by the chosen account's
  label, and the following request carried that account's key.
- **Logging.** Decision lines land in `~/.local/share/opencode/go-failover.log`.
- **Plugin install.** The failover half was verified as a separate package and now
  ships inside `github:ionutale/opencode-go-usage-plugin`.

## Not verified live

- **Reactive failover on a real 429.** No account was exhausted for a real error;
  the path is covered by unit tests with a synthetic provider failure.
- **A wait against OpenCode's retry attempt cap.** Would need a genuine multi-hour
  exhaustion. The delay is now clamped to `TIMER_MAX_MS` (2³¹−1) so it can never
  overflow into an immediate retry; how many waits the cap permits is unmeasured.
- **Mid-turn non-disturbance.** Structural: the plugin has no timer and evaluates
  only at prompt admission, so it cannot switch during a streaming turn.

## Unit coverage

`pnpm test` → 160 tests, `pnpm typecheck` clean. Covered: config parsing, usage
parsing and caching, timeout, error classification (including context overflow),
account evaluation, candidate choice by renewal and headroom floor, blocking-window reset math,
timer clamping, credential store, both hooks, degraded-mode cap, notifications,
and the logger.
