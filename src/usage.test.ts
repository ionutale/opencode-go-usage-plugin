import { describe, expect, it } from "vitest"
import {
  barSegments,
  describeRpcError,
  formatDuration,
  formatResetsIn,
  formatUsageRows,
  parseUsageResponse,
  usageColor,
  UsageParseError,
} from "./usage"

const SAMPLE = {
  usage: {
    rolling: { status: "ok", percent: 40, resetsAt: "2026-09-27T19:03:37.947Z" },
    weekly: { status: "ok", percent: 77, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 64, resetsAt: "2026-10-05T10:02:18.000Z" },
  },
}

describe("parseUsageResponse", () => {
  it("parses a valid response", () => {
    const usage = parseUsageResponse(SAMPLE)
    expect(usage.rolling.percent).toBe(40)
    expect(usage.weekly.resetsAt).toBe("2026-09-28T00:00:00.000Z")
    expect(usage.monthly.status).toBe("ok")
  })

  it("rejects a response without usage", () => {
    expect(() => parseUsageResponse({})).toThrow(UsageParseError)
  })

  it("rejects a missing window", () => {
    const broken = { usage: { ...SAMPLE.usage, weekly: undefined } }
    expect(() => parseUsageResponse(broken)).toThrow(UsageParseError)
  })

  it("rejects a string percent", () => {
    const broken = { usage: { ...SAMPLE.usage, rolling: { ...SAMPLE.usage.rolling, percent: "40" } } }
    expect(() => parseUsageResponse(broken)).toThrow(UsageParseError)
  })

  it("rejects an invalid resetsAt", () => {
    const broken = { usage: { ...SAMPLE.usage, monthly: { ...SAMPLE.usage.monthly, resetsAt: "soon" } } }
    expect(() => parseUsageResponse(broken)).toThrow(UsageParseError)
  })
})

describe("formatDuration", () => {
  it.each([
    [0, "0m"],
    [-5000, "0m"],
    [59_999, "0m"],
    [45 * 60_000, "45m"],
    [(60 + 13) * 60_000, "1h 13m"],
    [(6 * 60 + 9) * 60_000, "6h 9m"],
    [24 * 60 * 60_000, "1d 0h"],
    [(7 * 1440 + 16 * 60) * 60_000, "7d 16h"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe("formatResetsIn", () => {
  it("formats the remaining time", () => {
    const now = Date.parse("2026-09-27T17:50:00.000Z")
    expect(formatResetsIn("2026-09-27T19:03:37.947Z", now)).toBe("1h 13m")
  })

  it("clamps past timestamps to 0m", () => {
    const now = Date.parse("2026-09-27T20:00:00.000Z")
    expect(formatResetsIn("2026-09-27T19:03:37.947Z", now)).toBe("0m")
  })

  it("clamps invalid timestamps to 0m", () => {
    expect(formatResetsIn("not-a-date", Date.now())).toBe("0m")
  })
})

describe("barSegments", () => {
  it("renders proportional segments", () => {
    expect(barSegments(0)).toBe("░░░░░░░░░░")
    expect(barSegments(40)).toBe("████░░░░░░")
    expect(barSegments(100)).toBe("██████████")
  })

  it("rounds and clamps out-of-range values", () => {
    expect(barSegments(44)).toBe("████░░░░░░")
    expect(barSegments(-10)).toBe("░░░░░░░░░░")
    expect(barSegments(140)).toBe("██████████")
    expect(barSegments(Number.NaN)).toBe("░░░░░░░░░░")
  })
})

describe("usageColor", () => {
  it.each([
    [0, "#22c55e"],
    [49, "#22c55e"],
    [50, "#eab308"],
    [74, "#eab308"],
    [75, "#ef4444"],
    [100, "#ef4444"],
  ])("maps %d to %s", (percent, expected) => {
    expect(usageColor(percent)).toBe(expected)
  })
})

describe("describeRpcError", () => {
  it("maps unprefixed error types", () => {
    expect(describeRpcError({ type: "unauthorized" })).toBe("check API key")
    expect(describeRpcError({ type: "no_credential" })).toBe("not connected")
  })

  it("maps rpc-prefixed error types", () => {
    expect(describeRpcError({ type: "rpc.go-usage.unauthorized" })).toBe("check API key")
    expect(describeRpcError({ type: "rpc.go-usage.forbidden" })).toBe("Go plan required")
  })

  it("falls back to error messages", () => {
    expect(describeRpcError(new Error("boom"))).toBe("boom")
    expect(describeRpcError({ data: { message: "inner" } })).toBe("inner")
  })

  it("falls back to unreachable", () => {
    expect(describeRpcError({ type: "surprise" })).toBe("unreachable")
    expect(describeRpcError(undefined)).toBe("unreachable")
  })
})

describe("formatUsageRows", () => {
  it("formats one aligned row per window", () => {
    const now = Date.parse("2026-09-27T17:50:00.000Z")
    const rows = formatUsageRows(
      { usage: parseUsageResponse(SAMPLE), fetchedAt: "2026-09-27T17:50:00.000Z" },
      now,
    )
    expect(rows).toEqual([
      "Rolling  ████░░░░░░   40%  1h 13m",
      "Weekly   ████████░░   77%  6h 10m",
      "Monthly  ██████░░░░   64%  7d 16h",
    ])
  })
})
