import type { UsageWindows } from "./usage"

export type Account = { credentialID: string; label: string }

export type Evaluated = Account & {
  usage: UsageWindows | undefined
  state: "available" | "blocked" | "unknown"
  headroom: number
  /** When the plan renews (the monthly window's `resetsAt`), in ms. Undefined when it cannot be parsed. */
  renewalAt: number | undefined
  /** The next weekly reset, in ms. */
  weeklyAt: number | undefined
  /** The next rolling reset, in ms. */
  rollingAt: number | undefined
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
  if (!usage) {
    return {
      ...account,
      usage,
      state: "unknown",
      headroom: 0,
      renewalAt: undefined,
      weeklyAt: undefined,
      rollingAt: undefined,
    }
  }
  const windows = [usage.rolling, usage.weekly, usage.monthly]
  const blocked = windows.some((window) => window.status !== "ok" || window.percent >= 100)
  const headroom = Math.max(0, Math.min(...windows.map((window) => 100 - window.percent)))
  const renewal = Date.parse(usage.monthly.resetsAt)
  const weekly = Date.parse(usage.weekly.resetsAt)
  const rolling = Date.parse(usage.rolling.resetsAt)
  return {
    ...account,
    usage,
    state: blocked ? "blocked" : "available",
    headroom,
    renewalAt: Number.isFinite(renewal) ? renewal : undefined,
    weeklyAt: Number.isFinite(weekly) ? weekly : undefined,
    rollingAt: Number.isFinite(rolling) ? rolling : undefined,
  }
}

export function orderIndex(order: readonly string[], account: Account): number {
  const index = order.findIndex((entry) => entry === account.credentialID || entry === account.label)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

export function chooseCandidate(input: {
  accounts: readonly Evaluated[]
  activeID: string | undefined
  order: readonly string[]
  /** Minimum headroom across every window; 0 disables the floor. */
  minHeadroom: number
  /** When set, only accounts whose monthly usage is below this percentage are eligible. */
  monthlyUnder?: number
  /** Current time; a monthly renewal at or before this is expired. */
  nowMs: number
}): Evaluated | undefined {
  // Monthly renewal is the hard deadline, so it sorts first. Weekly and
  // rolling resets only break ties; they do not expire a subscription. A past
  // monthly reset is expired and skipped. The default has no short-window
  // floor: use the account until a window hits 100%, then let the reactive
  // path recover the block.
  const monthly = (account: Evaluated) => account.usage?.monthly.percent ?? 100
  const rank = (account: Evaluated) => account.renewalAt ?? Number.POSITIVE_INFINITY

  return input.accounts
    .filter((account) => account.state === "available" && account.credentialID !== input.activeID)
    .filter((account) => rank(account) > input.nowMs)
    .filter((account) => account.headroom >= input.minHeadroom)
    .filter((account) => input.monthlyUnder === undefined || monthly(account) < input.monthlyUnder)
    .sort((left, right) => {
      const byMonthly = compareTime(left.renewalAt, right.renewalAt)
      if (byMonthly !== 0) return byMonthly
      const byWeekly = compareTime(left.weeklyAt, right.weeklyAt)
      if (byWeekly !== 0) return byWeekly
      const byRolling = compareTime(left.rollingAt, right.rollingAt)
      if (byRolling !== 0) return byRolling
      const byOrder = orderIndex(input.order, left) - orderIndex(input.order, right)
      if (byOrder !== 0) return byOrder
      return right.headroom - left.headroom
    })[0]
}

function compareTime(left: number | undefined, right: number | undefined): number {
  const leftRank = left ?? Number.POSITIVE_INFINITY
  const rightRank = right ?? Number.POSITIVE_INFINITY
  if (leftRank === rightRank) return 0
  return leftRank < rightRank ? -1 : 1
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
    // An expired subscription has no future share; waiting for its short
    // windows cannot make the monthly quota come back.
    if (account.renewalAt !== undefined && account.renewalAt <= nowMs) continue
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
