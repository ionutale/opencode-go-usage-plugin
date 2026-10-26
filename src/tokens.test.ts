import { describe, expect, it } from "vitest"
import type { UsageResult } from "./usage"
import {
  aggregateModels,
  describeRange,
  filterRows,
  fitNumber,
  fitText,
  formatCost,
  formatTokens,
  modelOptions,
  parseStatsResponse,
  providerOptions,
  rangeWindow,
  sortRows,
  sumRows,
  tokenColumns,
  totalTokens,
  StatsParseError,
  type StatsModel,
  type TokenColumn,
  type TokenRow,
  type TokenTotals,
} from "./tokens"

const NOW = Date.parse("2026-10-26T12:00:00.000Z")

function usage(overrides: Partial<UsageResult["usage"]> = {}, stale = false): UsageResult {
  return {
    usage: {
      rolling: { status: "ok", percent: 10, resetsAt: "2026-10-26T15:00:00.000Z" },
      weekly: { status: "ok", percent: 20, resetsAt: "2026-11-02T00:00:00.000Z" },
      monthly: { status: "ok", percent: 30, resetsAt: "2026-11-21T07:45:00.000Z" },
      ...overrides,
    },
    fetchedAt: "2026-10-26T12:00:00.000Z",
    ...(stale ? { stale: true } : {}),
  }
}

function model(
  providerID: string,
  id: string,
  input: number,
  output: number,
  variant?: string,
  steps = 1,
  cost = 0,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
): StatsModel {
  return {
    model: { id, providerID, ...(variant === undefined ? {} : { variant }) },
    steps,
    tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
    cost,
  }
}

function row(providerID: string, modelID: string, total: number): TokenRow {
  return {
    providerID,
    modelID,
    input: total,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total,
    steps: 1,
    cost: 0,
    variants: [],
  }
}

describe("totalTokens", () => {
  it("sums input, output, reasoning, and both cache directions", () => {
    expect(
      totalTokens({
        input: 10,
        output: 20,
        reasoning: 30,
        cache: { read: 40, write: 50 },
      }),
    ).toBe(150)
  })
})

describe("rangeWindow", () => {
  it("uses the last five hours for rolling", () => {
    expect(rangeWindow("rolling", usage(), NOW)).toEqual({
      key: "rolling",
      from: NOW - 5 * 60 * 60 * 1000,
      to: NOW + 1,
      approximate: false,
    })
  })

  it("anchors the weekly window to the official reset", () => {
    expect(rangeWindow("week", usage(), NOW)).toEqual({
      key: "week",
      from: Date.parse("2026-10-26T00:00:00.000Z"),
      to: NOW + 1,
      approximate: false,
    })
  })

  it("anchors the monthly window to the official reset minus one month", () => {
    expect(rangeWindow("month", usage(), NOW)).toEqual({
      key: "month",
      from: Date.parse("2026-10-21T07:45:00.000Z"),
      to: NOW + 1,
      approximate: false,
    })
  })

  it("clamps month-end subtraction", () => {
    const window = rangeWindow(
      "month",
      usage({ monthly: { status: "ok", percent: 10, resetsAt: "2026-03-31T10:00:00.000Z" } }),
      Date.parse("2026-03-15T12:00:00.000Z"),
    )
    expect(window.from).toBe(Date.parse("2026-02-28T10:00:00.000Z"))
  })

  it("clamps leap-year month-end subtraction", () => {
    const window = rangeWindow(
      "month",
      usage({ monthly: { status: "ok", percent: 10, resetsAt: "2028-03-31T10:00:00.000Z" } }),
      Date.parse("2028-03-15T12:00:00.000Z"),
    )
    expect(window.from).toBe(Date.parse("2028-02-29T10:00:00.000Z"))
  })

  it("falls back to the start of the ISO week in UTC", () => {
    expect(rangeWindow("week", undefined, NOW)).toEqual({
      key: "week",
      from: Date.parse("2026-10-26T00:00:00.000Z"),
      to: NOW + 1,
      approximate: true,
    })
  })

  it("falls back to the start of the calendar month in UTC", () => {
    expect(rangeWindow("month", undefined, NOW)).toEqual({
      key: "month",
      from: Date.parse("2026-10-01T00:00:00.000Z"),
      to: NOW + 1,
      approximate: true,
    })
  })

  it("falls back when the official reset is stale", () => {
    expect(rangeWindow("month", usage({}, true), NOW)).toEqual({
      key: "month",
      from: Date.parse("2026-10-01T00:00:00.000Z"),
      to: NOW + 1,
      approximate: true,
    })
  })

  it("falls back when a reset is invalid", () => {
    expect(
      rangeWindow(
        "week",
        usage({ weekly: { status: "ok", percent: 10, resetsAt: "not-a-date" } }),
        NOW,
      ),
    ).toEqual({
      key: "week",
      from: Date.parse("2026-10-26T00:00:00.000Z"),
      to: NOW + 1,
      approximate: true,
    })
  })

  it("has no lower bound for all time", () => {
    expect(rangeWindow("all", usage(), NOW)).toEqual({
      key: "all",
      from: undefined,
      to: NOW + 1,
      approximate: false,
    })
  })
})

describe("aggregateModels", () => {
  const models = [
    model("opencode-go", "deepseek-v4.1-flash", 100, 10, "max", 2, 0.5, 1000, 2, 5),
    model("opencode-go", "deepseek-v4.1-flash", 200, 20, "default", 3, 0.7, 2000, 3, 10),
    model("ollama", "qwen3.8:27b", 50, 5),
  ]

  it("aggregates variants into one provider+model row", () => {
    const rows = aggregateModels(models)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      input: 300,
      output: 30,
      reasoning: 15,
      cacheRead: 3000,
      cacheWrite: 5,
      total: 3350,
      steps: 5,
      cost: 1.2,
      variants: ["default", "max"],
    })
    expect(rows[1]).toEqual({
      providerID: "ollama",
      modelID: "qwen3.8:27b",
      input: 50,
      output: 5,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 55,
      steps: 1,
      cost: 0,
      variants: [],
    })
  })

  it("keeps the same model under different providers separate", () => {
    const rows = aggregateModels([model("a", "shared", 1, 0), model("b", "shared", 2, 0)])
    expect(rows.map((item) => item.providerID)).toEqual(["a", "b"])
  })
})

describe("filterRows", () => {
  const rows = [row("opencode-go", "deepseek", 30), row("opencode-go", "glm", 20), row("ollama", "qwen", 10)]

  it("filters by provider", () => {
    expect(filterRows(rows, "opencode-go", "all").map((item) => item.modelID)).toEqual(["deepseek", "glm"])
  })

  it("filters by model", () => {
    expect(filterRows(rows, "all", "qwen").map((item) => item.providerID)).toEqual(["ollama"])
  })

  it("keeps everything for all/all", () => {
    expect(filterRows(rows, "all", "all")).toHaveLength(3)
  })
})

describe("sortRows", () => {
  const rows = [row("b", "two", 20), row("a", "one", 20), row("c", "three", 30)]

  it("sorts by total descending", () => {
    expect(sortRows(rows, "total", "desc").map((item) => item.modelID)).toEqual(["three", "one", "two"])
  })

  it("sorts by total ascending", () => {
    expect(sortRows(rows, "total", "asc").map((item) => item.modelID)).toEqual(["one", "two", "three"])
  })

  it("does not mutate the input", () => {
    const before = rows.map((item) => item.modelID)
    sortRows(rows, "total", "desc")
    expect(rows.map((item) => item.modelID)).toEqual(before)
  })
})

describe("sumRows", () => {
  it("sums every column", () => {
    const rows = aggregateModels([
      model("opencode-go", "deepseek", 100, 10, "max", 2, 0.5, 1000, 2, 5),
      model("ollama", "qwen", 50, 5),
    ])
    expect(sumRows(rows)).toEqual({
      input: 150,
      output: 15,
      reasoning: 5,
      cacheRead: 1000,
      cacheWrite: 2,
      total: 1172,
      steps: 3,
      cost: 0.5,
    })
  })

  it("returns zeros for no rows", () => {
    expect(sumRows([])).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      steps: 0,
      cost: 0,
    })
  })
})

describe("provider and model options", () => {
  const rows = [row("opencode-go", "deepseek", 1), row("opencode-go", "glm", 1), row("ollama", "qwen", 1)]

  it("lists sorted unique providers", () => {
    expect(providerOptions(rows)).toEqual(["ollama", "opencode-go"])
  })

  it("lists models within a provider", () => {
    expect(modelOptions(rows, "opencode-go")).toEqual(["deepseek", "glm"])
  })

  it("lists every model when provider is all", () => {
    expect(modelOptions(rows, "all")).toEqual(["deepseek", "glm", "qwen"])
  })
})

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1K"],
    [1_500_000, "1.5M"],
    [13_920_000, "13.9M"],
  ])("formats %d compactly as %s", (value, expected) => {
    expect(formatTokens(value, false)).toBe(expected)
  })

  it("formats exact values with separators", () => {
    expect(formatTokens(13_920_000, true)).toBe("13,920,000")
  })
})

describe("formatCost", () => {
  it("formats USD with two decimals and separators", () => {
    expect(formatCost(0)).toBe("$0.00")
    expect(formatCost(1234.5)).toBe("$1,234.50")
  })
})

describe("describeRange", () => {
  it("describes the subscription month in UTC", () => {
    const text = describeRange(rangeWindow("month", usage(), NOW), "UTC")
    expect(text).toContain("Subscription month")
    expect(text).toContain("Oct 21, 07:45")
    expect(text).toContain("Oct 26, 12:00")
    expect(text).toContain("UTC")
    expect(text).not.toContain("quota unavailable")
  })

  it("marks the fallback when quota is unavailable", () => {
    const text = describeRange(rangeWindow("month", undefined, NOW), "UTC")
    expect(text).toContain("Subscription month")
    expect(text).toContain("quota unavailable")
  })

  it("describes rolling and all-time windows", () => {
    expect(describeRange(rangeWindow("rolling", usage(), NOW), "UTC")).toContain("Rolling 5h")
    expect(describeRange(rangeWindow("all", usage(), NOW), "UTC")).toBe("All local history")
  })
})

describe("rangeWindow with expired resets", () => {
  it("falls back when the weekly reset has passed", () => {
    const window = rangeWindow(
      "week",
      usage({ weekly: { status: "ok", percent: 10, resetsAt: new Date(NOW - 60_000).toISOString() } }),
      NOW,
    )
    expect(window.from).toBe(Date.parse("2026-10-26T00:00:00.000Z"))
    expect(window.approximate).toBe(true)
  })

  it("falls back when the monthly reset has passed", () => {
    const window = rangeWindow(
      "month",
      usage({ monthly: { status: "ok", percent: 10, resetsAt: new Date(NOW - 86_400_000).toISOString() } }),
      NOW,
    )
    expect(window.from).toBe(Date.parse("2026-10-01T00:00:00.000Z"))
    expect(window.approximate).toBe(true)
  })

  it("falls back exactly at the reset instant", () => {
    const window = rangeWindow(
      "week",
      usage({ weekly: { status: "ok", percent: 10, resetsAt: new Date(NOW).toISOString() } }),
      NOW,
    )
    expect(window.from).toBe(Date.parse("2026-10-26T00:00:00.000Z"))
    expect(window.approximate).toBe(true)
  })
})

describe("parseStatsResponse", () => {
  const valid = {
    models: [
      {
        model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "max" },
        steps: 2,
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 2 } },
        cost: 0.5,
        ignored: "extra field",
      },
    ],
    range: { from: 1, to: 2 },
    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 2 } },
  }

  it("parses model rows and ignores unrelated fields", () => {
    expect(parseStatsResponse(valid)).toEqual({
      models: [
        {
          model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "max" },
          steps: 2,
          tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 2 } },
          cost: 0.5,
        },
      ],
    })
  })

  it("rejects a payload without a models array", () => {
    expect(() => parseStatsResponse({})).toThrow(StatsParseError)
    expect(() => parseStatsResponse({ models: "nope" })).toThrow(StatsParseError)
    expect(() => parseStatsResponse(undefined)).toThrow(StatsParseError)
  })

  it("skips malformed rows", () => {
    const result = parseStatsResponse({
      models: [
        null,
        { model: { id: "missing-provider" }, steps: 1, tokens: { input: 1 } },
        {
          model: { id: "ok", providerID: "opencode-go" },
          steps: 1,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 4 } },
          cost: 0,
        },
      ],
    })
    expect(result.models).toHaveLength(1)
    expect(result.models[0]?.model.id).toBe("ok")
  })

  it("coerces non-finite numbers to zero", () => {
    const result = parseStatsResponse({
      models: [
        {
          model: { id: "ok", providerID: "opencode-go" },
          steps: Number.NaN,
          tokens: {
            input: Number.NaN,
            output: Number.POSITIVE_INFINITY,
            reasoning: 0,
            cache: { read: Number.NaN, write: Number.NEGATIVE_INFINITY },
          },
          cost: Number.NaN,
        },
      ],
    })
    expect(result.models[0]).toEqual({
      model: { id: "ok", providerID: "opencode-go" },
      steps: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    })
  })
})

describe("fitText and fitNumber", () => {
  it("pads short text and truncates long text with an ellipsis", () => {
    expect(fitText("abc", 5)).toBe("abc  ")
    expect(fitText("abcdefgh", 5)).toBe("abcd…")
  })

  it("pads short numbers and never truncates a long number", () => {
    expect(fitNumber("42", 5)).toBe("   42")
    expect(fitNumber("2,200,000,000", 10)).toBe("2,200,000,000")
  })
})

const COLUMN_ROWS: TokenRow[] = [
  {
    providerID: "opencode-go",
    modelID: "deepseek-v4.1-flash",
    input: 61_900_000,
    output: 3_800_000,
    reasoning: 7_000_000,
    cacheRead: 2_200_000_000,
    cacheWrite: 0,
    total: 2_272_700_000,
    steps: 10_549,
    cost: 0.56,
    variants: [],
  },
  {
    providerID: "opencode-go",
    modelID: "longcat-2.5-preview-free",
    input: 180_000,
    output: 66_200,
    reasoning: 154,
    cacheRead: 3_100_000,
    cacheWrite: 0,
    total: 3_346_354,
    steps: 31,
    cost: 0.01,
    variants: [],
  },
]

function numericValues(column: TokenColumn, rows: TokenRow[], totals: TokenTotals, exact: boolean): string[] {
  const values: string[] = []
  const read = (row: TokenRow) => {
    switch (column.key) {
      case "input":
        return formatTokens(row.input, exact)
      case "output":
        return formatTokens(row.output, exact)
      case "reasoning":
        return formatTokens(row.reasoning, exact)
      case "cacheRead":
        return formatTokens(row.cacheRead, exact)
      case "cacheWrite":
        return formatTokens(row.cacheWrite, exact)
      case "total":
        return formatTokens(row.total, exact)
      case "steps":
        return formatTokens(row.steps, true)
      case "cost":
        return formatCost(row.cost)
      default:
        return ""
    }
  }
  for (const row of rows) values.push(read(row))
  switch (column.key) {
    case "input":
      values.push(formatTokens(totals.input, exact))
      break
    case "output":
      values.push(formatTokens(totals.output, exact))
      break
    case "reasoning":
      values.push(formatTokens(totals.reasoning, exact))
      break
    case "cacheRead":
      values.push(formatTokens(totals.cacheRead, exact))
      break
    case "cacheWrite":
      values.push(formatTokens(totals.cacheWrite, exact))
      break
    case "total":
      values.push(formatTokens(totals.total, exact))
      break
    case "steps":
      values.push(formatTokens(totals.steps, true))
      break
    case "cost":
      values.push(formatCost(totals.cost))
      break
  }
  return values
}

function tableWidth(columns: readonly TokenColumn[]): number {
  return columns.reduce((sum, column) => sum + column.width, 0) + Math.max(0, columns.length - 1)
}

function expectNoNumericTruncation(columns: readonly TokenColumn[], rows: TokenRow[], exact: boolean): void {
  const totals = sumRows(rows)
  for (const column of columns) {
    if (column.key === "provider" || column.key === "model") continue
    for (const value of numericValues(column, rows, totals, exact)) {
      expect(column.width).toBeGreaterThanOrEqual(value.length)
    }
  }
}

describe("tokenColumns", () => {
  it("fits every numeric value at 112 columns in exact mode", () => {
    const columns = tokenColumns(COLUMN_ROWS, sumRows(COLUMN_ROWS), { width: 112, exact: true, cost: false })
    expect(columns.map((column) => column.key)).toEqual([
      "provider",
      "model",
      "input",
      "output",
      "reasoning",
      "cacheRead",
      "cacheWrite",
      "total",
      "steps",
    ])
    expect(tableWidth(columns)).toBeLessThanOrEqual(112)
    expectNoNumericTruncation(columns, COLUMN_ROWS, true)
  })

  it("drops reasoning, then steps, before cache write at 92 columns", () => {
    const columns = tokenColumns(COLUMN_ROWS, sumRows(COLUMN_ROWS), { width: 92, exact: true, cost: false })
    const keys = columns.map((column) => column.key)
    expect(keys).not.toContain("reasoning")
    expect(keys).not.toContain("steps")
    expect(keys).toContain("cacheWrite")
    expect(tableWidth(columns)).toBeLessThanOrEqual(92)
    expectNoNumericTruncation(columns, COLUMN_ROWS, true)
  })

  it("keeps cost and drops reasoning before optional columns at 112 columns", () => {
    const costly = COLUMN_ROWS.map((row, index) => ({ ...row, cost: index === 0 ? 12_345.67 : 0.01 }))
    const columns = tokenColumns(costly, sumRows(costly), { width: 112, exact: true, cost: true })
    const keys = columns.map((column) => column.key)
    expect(keys).toContain("cost")
    expect(keys).not.toContain("reasoning")
    expect(tableWidth(columns)).toBeLessThanOrEqual(112)
    expectNoNumericTruncation(columns, costly, true)
  })
})
