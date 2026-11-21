import type { UsageWindows } from "./usage"

export type Account = { credentialID: string; label: string }

export type Evaluated = Account & {
  usage: UsageWindows | undefined
  state: "available" | "blocked" | "unknown"
  headroom: number
  /** When the plan renews (the monthly window's `resetsAt`), in ms. Undefined when it cannot be parsed. */
  renewalAt: number | undefined
}

export const TIMER_MAX_MS = 2_147_483_647

const LIMIT_PATTERN = /usage limit|allowance|rate limit|limit reached|limit exceeded|quota/i

/** Host error types that mean "this credential is out of quota". */
const LIMIT_TYPES = new Set(["provider.go-limit", "provider.quota"])

/** Host error types that no credential switch can fix. */
const NON_LIMIT_TYPES = new Set([
  "provider.invalid-request",
  "provider.budget-limit",
  "provider.model-budget-limit",
  "provider.free-limit",
  "provider.content-filter",
  "provider.auth",
  "provider.transport",
])

/** Messages that look limit-shaped but describe the request, not the account. */
const NON_LIMIT_MESSAGE = /context[_ ]length|context window|too many tokens|payload|request body|max(?:imum)? output|tool schema/i

export function classifyLimitError(error: { type: string; message: string; status?: number }): boolean {
  const type = (error.type ?? "").toLowerCase()
  // The host's quota types are authoritative whatever the status.
  if (LIMIT_TYPES.has(type)) return true
  // Budget, free-tier, auth, filter, and transport failures are not fixed by
  // switching accounts, even when they arrive as a 4xx.
  if (NON_LIMIT_TYPES.has(type) && type !== "provider.invalid-request") return false
  // 429/402 are limit errors whatever the type, including an untyped 429.
  if (error.status === 429 || error.status === 402) return true
  // A definitive 4xx is the request's fault, not the account's.
  if (typeof error.status === "number" && error.status >= 400 && error.status < 500) return false

  const message = error.message ?? ""
  if (NON_LIMIT_MESSAGE.test(message)) return false
  const haystack = `${type} ${message}`.replace(/[-_]/g, " ")
  return LIMIT_PATTERN.test(haystack)
}

export function evaluate(account: Account, usage: UsageWindows | undefined): Evaluated {
  if (!usage) return { ...account, usage, state: "unknown", headroom: 0, renewalAt: undefined }
  const windows = [usage.rolling, usage.weekly, usage.monthly]
  const blocked = windows.some((window) => window.status !== "ok" || window.percent >= 100)
  const headroom = Math.max(0, Math.min(...windows.map((window) => 100 - window.percent)))
  const renewal = Date.parse(usage.monthly.resetsAt)
  return { ...account, usage, state: blocked ? "blocked" : "available", headroom, renewalAt: Number.isFinite(renewal) ? renewal : undefined }
}

export function orderIndex(order: readonly string[], account: Account): number {
  const index = order.findIndex((entry) => entry === account.credentialID || entry === account.label)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

export function chooseCandidate(input: {
  accounts: readonly Evaluated[]
  activeID: string | undefined
  order: readonly string[]
  hysteresisPoints: number
}): Evaluated | undefined {
  const active = input.accounts.find((account) => account.credentialID === input.activeID)
  const activeHeadroom = active?.state === "available" ? active.headroom : 0

  // The plan renewal decides the order: the account whose monthly window
  // renews soonest is the one whose quota would otherwise be wasted. Rolling
  // and weekly windows reset too often to say anything about renewal order.
  // Headroom only breaks ties, and the hysteresis gate still decides whether
  // to move at all.
  const renewalRank = (account: Evaluated) => account.renewalAt ?? Number.POSITIVE_INFINITY

  const best = input.accounts
    .filter((account) => account.state === "available" && account.credentialID !== input.activeID)
    .sort((left, right) => {
      const leftRenewal = renewalRank(left)
      const rightRenewal = renewalRank(right)
      if (leftRenewal !== rightRenewal) return leftRenewal < rightRenewal ? -1 : 1
      if (right.headroom !== left.headroom) return right.headroom - left.headroom
      return orderIndex(input.order, left) - orderIndex(input.order, right)
    })[0]

  if (!best) return undefined
  if (best.headroom - activeHeadroom < input.hysteresisPoints) return undefined
  return best
}

function blocking(window: { status: string; percent: number }): boolean {
  return window.status !== "ok" || window.percent >= 100
}

/**
 * Milliseconds until the soonest account can serve requests again. An account is
 * serviceable once *every* blocking window has reset, so a weekly block is not
 * mistaken for the rolling window that happens to reset first.
 */
export function soonestReset(accounts: readonly Evaluated[], nowMs: number): number | undefined {
  let soonest: number | undefined
  for (const account of accounts) {
    if (!account.usage) continue
    if (account.state === "available") return 0

    const windows = [account.usage.rolling, account.usage.weekly, account.usage.monthly].filter(blocking)
    let readyAt = Number.NEGATIVE_INFINITY
    for (const window of windows) {
      const at = Date.parse(window.resetsAt)
      if (Number.isNaN(at)) continue
      readyAt = Math.max(readyAt, at)
    }
    if (readyAt === Number.NEGATIVE_INFINITY) continue

    const remaining = Math.max(0, readyAt - nowMs)
    if (soonest === undefined || remaining < soonest) soonest = remaining
  }
  return soonest
}

export function waitDelay(input: {
  accounts: readonly Evaluated[]
  nowMs: number
  retryAfterMs?: number
  bufferMs: number
  maxWaitMs: number
}): number {
  const reset = soonestReset(input.accounts, input.nowMs) ?? 0
  const retryAfter =
    typeof input.retryAfterMs === "number" && Number.isFinite(input.retryAfterMs) && input.retryAfterMs > 0
      ? input.retryAfterMs
      : 0
  const delay = Math.max(reset, retryAfter) + input.bufferMs
  const ceiling = Math.min(Number.isFinite(input.maxWaitMs) ? input.maxWaitMs : TIMER_MAX_MS, TIMER_MAX_MS)
  if (!Number.isFinite(delay)) return ceiling
  return Math.min(Math.max(0, delay), ceiling)
}
