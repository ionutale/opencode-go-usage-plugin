import { describe, expect, it } from "vitest"
import { chooseCandidate, classifyLimitError, evaluate, soonestReset, waitDelay, TIMER_MAX_MS, type Account } from "./policy"
import type { UsageWindows } from "./usage"

const HOUR = 3_600_000
const NOW = Date.parse("2026-11-19T12:00:00.000Z")

function usage(rolling: number, weekly = 10, monthly = 10, status = "ok"): UsageWindows {
  return {
    rolling: { status, percent: rolling, resetsAt: new Date(NOW + HOUR).toISOString() },
    weekly: { status: "ok", percent: weekly, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
    monthly: { status: "ok", percent: monthly, resetsAt: new Date(NOW + 72 * HOUR).toISOString() },
  }
}

/** Every window at the same percent and the same reset, for ordering tests. */
function atReset(percent: number, resetInMs: number): UsageWindows {
  const resetsAt = new Date(NOW + resetInMs).toISOString()
  return {
    rolling: { status: "ok", percent, resetsAt },
    weekly: { status: "ok", percent, resetsAt },
    monthly: { status: "ok", percent, resetsAt },
  }
}

/** Fixed weekly reset, with rolling and monthly set apart, for renewal tests. */
function withMonthly(percent: number, monthlyResetInMs: number, rollingResetInMs = HOUR): UsageWindows {
  return {
    rolling: { status: "ok", percent, resetsAt: new Date(NOW + rollingResetInMs).toISOString() },
    weekly: { status: "ok", percent, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
    monthly: { status: "ok", percent, resetsAt: new Date(NOW + monthlyResetInMs).toISOString() },
  }
}

/** Distinct window percentages, with the monthly renewal set independently. */
function windowsAt(input: {
  rolling: number
  weekly: number
  monthly: number
  monthlyResetInMs: number
}): UsageWindows {
  return {
    rolling: { status: "ok", percent: input.rolling, resetsAt: new Date(NOW + HOUR).toISOString() },
    weekly: { status: "ok", percent: input.weekly, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
    monthly: {
      status: "ok",
      percent: input.monthly,
      resetsAt: new Date(NOW + input.monthlyResetInMs).toISOString(),
    },
  }
}

const account = (id: string): Account => ({ credentialID: id, label: id })

describe("classifyLimitError", () => {
  it("accepts a 429", () => {
    expect(classifyLimitError({ type: "provider.unknown", message: "", status: 429 })).toBe(true)
  })

  it("accepts limit-shaped types and messages", () => {
    expect(classifyLimitError({ type: "provider.rate-limit", message: "" })).toBe(true)
    expect(classifyLimitError({ type: "unknown", message: "weekly limit reached" })).toBe(true)
    expect(classifyLimitError({ type: "unknown", message: "You have exceeded your quota" })).toBe(true)
  })

  it("rejects unrelated failures", () => {
    expect(classifyLimitError({ type: "provider.invalid-request", message: "bad tool schema", status: 400 })).toBe(false)
    expect(classifyLimitError({ type: "unknown", message: "" })).toBe(false)
    expect(classifyLimitError({ type: "aborted", message: "aborted" })).toBe(false)
  })

  it("does not treat a context overflow as a usage limit", () => {
    expect(classifyLimitError({ type: "provider.invalid-request", message: "context length exceeded", status: 400 })).toBe(false)
    expect(classifyLimitError({ type: "unknown", message: "context window exceeded" })).toBe(false)
  })

  it("rotates on the host's Go limit type whatever the status", () => {
    for (const status of [undefined, 400, 402, 403]) {
      expect(
        classifyLimitError({
          type: "provider.go-limit",
          message: "OpenCode Go weekly usage limit reached. Switch to a free model.",
          status,
        }),
      ).toBe(true)
    }
  })

  it("does not rotate for workspace or model budget limits", () => {
    expect(classifyLimitError({ type: "provider.budget-limit", message: "Workspace usage limit reached", status: 403 })).toBe(false)
    expect(
      classifyLimitError({ type: "provider.model-budget-limit", message: "gpt usage limit reached", status: 403 }),
    ).toBe(false)
  })

  it("does not rotate on a free-tier limit", () => {
    expect(classifyLimitError({ type: "provider.free-limit", message: "free usage limit reached" })).toBe(false)
  })

  it("treats 429 as a limit even for an invalid-request type", () => {
    expect(classifyLimitError({ type: "provider.invalid-request", message: "", status: 429 })).toBe(true)
  })

  it("keeps budget limits out even at 429", () => {
    expect(classifyLimitError({ type: "provider.budget-limit", message: "usage limit reached", status: 429 })).toBe(false)
  })

  it("treats 402 as a quota failure even without a known type", () => {
    expect(classifyLimitError({ type: "provider.unknown", message: "", status: 402 })).toBe(true)
  })
})

describe("evaluate", () => {
  it("is available with headroom from the fullest window", () => {
    const result = evaluate(account("a"), usage(40, 77, 64))
    expect(result.state).toBe("available")
    expect(result.headroom).toBe(23)
  })

  it("records the monthly renewal", () => {
    const result = evaluate(account("a"), usage(40, 77, 64))
    expect(result.renewalAt).toBe(NOW + 72 * HOUR)
  })

  it("is blocked when a window percent is 100", () => {
    expect(evaluate(account("a"), usage(100, 10, 10)).state).toBe("blocked")
  })

  it("is blocked when a window status is not ok", () => {
    expect(evaluate(account("a"), usage(12, 10, 10, "exhausted")).state).toBe("blocked")
  })

  it("is unknown without usage", () => {
    const result = evaluate(account("a"), undefined)
    expect(result.state).toBe("unknown")
    expect(result.headroom).toBe(0)
  })
})

describe("chooseCandidate", () => {
  const evaluated = (id: string) => evaluate(account(id), usage(40, 30, 20))

  it("picks the account whose plan renews soonest, not the one with the most headroom", () => {
    const accounts = [
      evaluate(account("active"), atReset(95, HOUR)),
      evaluate(account("roomy"), atReset(20, 72 * HOUR)),
      evaluate(account("soon"), atReset(60, 2 * HOUR)),
    ]
    const chosen = chooseCandidate({ accounts, activeID: "active", order: [], minHeadroom: 0 })
    expect(chosen?.credentialID).toBe("soon")
  })

  it("picks a sooner-renewing account even when it has less headroom than the active", () => {
    const accounts = [
      evaluate(account("active"), atReset(20, 72 * HOUR)),
      evaluate(account("soon"), atReset(60, 2 * HOUR)),
    ]
    const chosen = chooseCandidate({ accounts, activeID: "active", order: [], minHeadroom: 0 })
    expect(chosen?.credentialID).toBe("soon")
  })

  it("skips a candidate under the headroom floor and picks the next", () => {
    const accounts = [
      evaluate(account("active"), atReset(20, 72 * HOUR)),
      evaluate(account("soon"), atReset(95, HOUR)),
      evaluate(account("next"), atReset(50, 24 * HOUR)),
    ]
    const chosen = chooseCandidate({ accounts, activeID: "active", order: [], minHeadroom: 10 })
    expect(chosen?.credentialID).toBe("next")
  })

  it("skips an account whose monthly usage is at the drain threshold", () => {
    const accounts = [
      evaluate(account("active"), windowsAt({ rolling: 5, weekly: 5, monthly: 20, monthlyResetInMs: 72 * HOUR })),
      evaluate(account("atThreshold"), windowsAt({ rolling: 5, weekly: 5, monthly: 90, monthlyResetInMs: HOUR })),
      evaluate(account("next"), windowsAt({ rolling: 5, weekly: 5, monthly: 50, monthlyResetInMs: 24 * HOUR })),
    ]
    const chosen = chooseCandidate({
      accounts,
      activeID: "active",
      order: [],
      minHeadroom: 0,
      monthlyUnder: 90,
    })
    expect(chosen?.credentialID).toBe("next")
  })

  it("includes the active when it is the best eligible account", () => {
    const accounts = [
      evaluate(account("active"), windowsAt({ rolling: 5, weekly: 5, monthly: 20, monthlyResetInMs: HOUR })),
      evaluate(account("other"), windowsAt({ rolling: 5, weekly: 5, monthly: 10, monthlyResetInMs: 48 * HOUR })),
    ]
    const chosen = chooseCandidate({
      accounts,
      activeID: undefined,
      order: [],
      minHeadroom: 0,
      monthlyUnder: 90,
    })
    expect(chosen?.credentialID).toBe("active")
  })

  it("ignores a sooner rolling reset when the monthly renewal is later", () => {
    const accounts = [
      evaluate(account("rollingSoon"), withMonthly(50, 30 * 24 * HOUR, HOUR)),
      evaluate(account("renewsSoon"), withMonthly(50, 5 * 24 * HOUR, 4 * HOUR)),
    ]
    const chosen = chooseCandidate({ accounts, activeID: "active", order: [], minHeadroom: 0 })
    expect(chosen?.credentialID).toBe("renewsSoon")
  })

  it("prefers headroom when two accounts reset at the same time", () => {
    const accounts = [evaluate(account("a"), atReset(60, 2 * HOUR)), evaluate(account("b"), atReset(20, 2 * HOUR))]
    const chosen = chooseCandidate({ accounts, activeID: "active", order: [], minHeadroom: 0 })
    expect(chosen?.credentialID).toBe("b")
  })

  it("prefers an account with a known renewal over one that cannot be parsed", () => {
    const broken: UsageWindows = {
      rolling: { status: "ok", percent: 5, resetsAt: "not-a-date" },
      weekly: { status: "ok", percent: 5, resetsAt: "not-a-date" },
      monthly: { status: "ok", percent: 5, resetsAt: "not-a-date" },
    }
    const accounts = [evaluate(account("broken"), broken), evaluate(account("soon"), atReset(50, 2 * HOUR))]
    const chosen = chooseCandidate({ accounts, activeID: "active", order: [], minHeadroom: 0 })
    expect(chosen?.credentialID).toBe("soon")
  })

  it("prefers the earlier credentialOrder entry on a tie", () => {
    const accounts = [evaluated("b"), evaluated("a")]
    const chosen = chooseCandidate({ accounts, activeID: "active", order: ["a", "b"], minHeadroom: 0 })
    expect(chosen?.credentialID).toBe("a")
  })

  it("returns undefined when every other account is under the headroom floor", () => {
    const accounts = [evaluate(account("active"), atReset(20, 72 * HOUR)), evaluate(account("soon"), atReset(95, HOUR))]
    const chosen = chooseCandidate({ accounts, activeID: "active", order: [], minHeadroom: 10 })
    expect(chosen).toBeUndefined()
  })

  it("returns undefined when every other account is at the monthly threshold", () => {
    const accounts = [
      evaluate(account("active"), windowsAt({ rolling: 5, weekly: 5, monthly: 20, monthlyResetInMs: 72 * HOUR })),
      evaluate(account("soon"), windowsAt({ rolling: 5, weekly: 5, monthly: 90, monthlyResetInMs: HOUR })),
    ]
    const chosen = chooseCandidate({
      accounts,
      activeID: "active",
      order: [],
      minHeadroom: 0,
      monthlyUnder: 90,
    })
    expect(chosen).toBeUndefined()
  })

  it("skips blocked and unknown accounts", () => {
    const accounts = [evaluate(account("active"), usage(99, 99, 99)), evaluate(account("blocked"), usage(100)), evaluate(account("unknown"), undefined)]
    const chosen = chooseCandidate({ accounts, activeID: "active", order: [], minHeadroom: 0 })
    expect(chosen).toBeUndefined()
  })

  it("returns undefined when the active account is the only available one", () => {
    const accounts = [evaluated("active")]
    expect(chooseCandidate({ accounts, activeID: "active", order: [], minHeadroom: 0 })).toBeUndefined()
  })
})

describe("soonestReset", () => {
  it("waits for the last blocking window, not the first one to reset", () => {
    const weeklyBlocked = {
      rolling: { status: "ok", percent: 100, resetsAt: new Date(NOW + HOUR).toISOString() },
      weekly: { status: "ok", percent: 100, resetsAt: new Date(NOW + 72 * HOUR).toISOString() },
      monthly: { status: "ok", percent: 10, resetsAt: new Date(NOW + 240 * HOUR).toISOString() },
    }
    expect(soonestReset([evaluate(account("a"), weeklyBlocked)], NOW)).toBe(72 * HOUR)
  })

  it("ignores windows that are not blocking", () => {
    const rollingBlocked = {
      rolling: { status: "ok", percent: 100, resetsAt: new Date(NOW + HOUR).toISOString() },
      weekly: { status: "ok", percent: 90, resetsAt: new Date(NOW + 72 * HOUR).toISOString() },
      monthly: { status: "ok", percent: 10, resetsAt: new Date(NOW + 240 * HOUR).toISOString() },
    }
    expect(soonestReset([evaluate(account("a"), rollingBlocked)], NOW)).toBe(HOUR)
  })

  it("treats a blocking window whose reset already passed as ready now", () => {
    const past = {
      rolling: { status: "ok", percent: 100, resetsAt: new Date(NOW - HOUR).toISOString() },
      weekly: { status: "ok", percent: 10, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
      monthly: { status: "ok", percent: 10, resetsAt: new Date(NOW + 72 * HOUR).toISOString() },
    }
    expect(soonestReset([evaluate(account("a"), past)], NOW)).toBe(0)
  })

  it("returns the soonest account, including one that is available now", () => {
    const accounts = [
      evaluate(account("blocked"), usage(100, 100, 10)),
      evaluate(account("ready"), usage(40, 10, 10)),
    ]
    expect(soonestReset(accounts, NOW)).toBe(0)
  })

  it("returns undefined when nothing is known", () => {
    expect(soonestReset([evaluate(account("a"), undefined)], NOW)).toBeUndefined()
  })
})

describe("waitDelay", () => {
  const blocked = [evaluate(account("a"), usage(100, 10, 10))]

  it("uses the retryAfter floor when it is later than the reset", () => {
    const delay = waitDelay({ accounts: blocked, nowMs: NOW, retryAfterMs: 5 * HOUR, bufferMs: 0, maxWaitMs: Infinity })
    expect(delay).toBe(5 * HOUR)
  })

  it("adds the buffer", () => {
    const delay = waitDelay({ accounts: blocked, nowMs: NOW, bufferMs: 5_000, maxWaitMs: Infinity })
    expect(delay).toBe(HOUR + 5_000)
  })

  it("clamps to maxWaitMs", () => {
    expect(waitDelay({ accounts: blocked, nowMs: NOW, bufferMs: 5_000, maxWaitMs: 60_000 })).toBe(60_000)
  })

  it("clamps a wait beyond the platform timer maximum", () => {
    const monthAway = [
      evaluate(account("a"), {
        rolling: { status: "ok", percent: 100, resetsAt: new Date(NOW + 30 * 24 * HOUR).toISOString() },
        weekly: { status: "ok", percent: 100, resetsAt: new Date(NOW + 30 * 24 * HOUR).toISOString() },
        monthly: { status: "ok", percent: 100, resetsAt: new Date(NOW + 30 * 24 * HOUR).toISOString() },
      }),
    ]
    const delay = waitDelay({ accounts: monthAway, nowMs: NOW, bufferMs: 5_000, maxWaitMs: Infinity })
    expect(delay).toBe(TIMER_MAX_MS)
    expect(delay).toBeLessThanOrEqual(2_147_483_647)
  })

  it("never returns a negative or non-finite value", () => {
    const stale = [
      evaluate(account("a"), {
        rolling: { status: "ok", percent: 100, resetsAt: new Date(NOW - 2 * HOUR).toISOString() },
        weekly: { status: "ok", percent: 100, resetsAt: new Date(NOW - HOUR).toISOString() },
        monthly: { status: "ok", percent: 100, resetsAt: new Date(NOW - HOUR).toISOString() },
      }),
    ]
    expect(waitDelay({ accounts: stale, nowMs: NOW, retryAfterMs: Number.NaN, bufferMs: 5_000, maxWaitMs: Infinity })).toBe(5_000)
  })
})
