import type { UsageResult } from "./usage"

export const RANGE_KEYS = ["rolling", "week", "month", "all"] as const
export type RangeKey = (typeof RANGE_KEYS)[number]

export type TokenCounts = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type StatsModel = {
  model: { id: string; providerID: string; variant?: string }
  steps: number
  tokens: TokenCounts
  cost: number
}

/** The subset of SessionStatsInfo the token view needs. */
export type StatsResponse = {
  range: { from: number; to: number }
  tokens: TokenCounts
  models: readonly StatsModel[]
}

export type TokenRow = {
  providerID: string
  modelID: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  steps: number
  cost: number
  variants: string[]
}

export type TokenTotals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  steps: number
  cost: number
}

export type RangeWindow = {
  key: RangeKey
  from?: number
  to: number
  /** True when the official Go reset was unavailable or stale and a calendar fallback was used. */
  approximate: boolean
}

export type SortKey = "total" | "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite" | "steps" | "cost"
export type SortDirection = "asc" | "desc"

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function totalTokens(tokens: TokenCounts): number {
  return (
    finite(tokens.input) +
    finite(tokens.output) +
    finite(tokens.reasoning) +
    finite(tokens.cache.read) +
    finite(tokens.cache.write)
  )
}

function resetTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function subtractUtcMonth(ms: number): number {
  const date = new Date(ms)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const day = date.getUTCDate()
  const target = new Date(Date.UTC(year, month - 1, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()))
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, daysInTarget))
  return target.getTime()
}

function startOfIsoWeekUtc(ms: number): number {
  const date = new Date(ms)
  const day = date.getUTCDay()
  const daysSinceMonday = (day + 6) % 7
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday)
}

function startOfUtcMonth(ms: number): number {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

/**
 * The exact range for a preset. Week and month are anchored to the official Go
 * reset timestamps; without a fresh reset they fall back to UTC calendar
 * boundaries and are marked approximate.
 */
export function rangeWindow(key: RangeKey, usage: UsageResult | undefined, now: number): RangeWindow {
  const to = now + 1
  if (key === "all") return { key, from: undefined, to, approximate: false }
  if (key === "rolling") return { key, from: now - FIVE_HOURS_MS, to, approximate: false }

  if (key === "week") {
    if (usage?.stale !== true) {
      const reset = resetTime(usage?.usage.weekly.resetsAt)
      if (reset !== undefined) {
        const from = reset - SEVEN_DAYS_MS
        if (from < to) return { key, from, to, approximate: false }
      }
    }
    return { key, from: startOfIsoWeekUtc(now), to, approximate: true }
  }

  if (usage?.stale !== true) {
    const reset = resetTime(usage?.usage.monthly.resetsAt)
    if (reset !== undefined) {
      const from = subtractUtcMonth(reset)
      if (from < to) return { key, from, to, approximate: false }
    }
  }
  return { key, from: startOfUtcMonth(now), to, approximate: true }
}

/** Groups stats variants into one row per provider + model. */
export function aggregateModels(models: readonly StatsModel[]): TokenRow[] {
  const rows = new Map<string, TokenRow>()

  for (const item of models) {
    const providerID = item.model.providerID
    const modelID = item.model.id
    const input = finite(item.tokens.input)
    const output = finite(item.tokens.output)
    const reasoning = finite(item.tokens.reasoning)
    const cacheRead = finite(item.tokens.cache.read)
    const cacheWrite = finite(item.tokens.cache.write)
    const total = input + output + reasoning + cacheRead + cacheWrite
    const steps = finite(item.steps)
    const cost = finite(item.cost)
    const variant = item.model.variant
    const key = `${providerID}\u0000${modelID}`
    const existing = rows.get(key)

    if (existing) {
      existing.input += input
      existing.output += output
      existing.reasoning += reasoning
      existing.cacheRead += cacheRead
      existing.cacheWrite += cacheWrite
      existing.total += total
      existing.steps += steps
      existing.cost += cost
      if (variant && !existing.variants.includes(variant)) existing.variants.push(variant)
      continue
    }

    rows.set(key, {
      providerID,
      modelID,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      total,
      steps,
      cost,
      variants: variant ? [variant] : [],
    })
  }

  for (const row of rows.values()) row.variants.sort()
  return [...rows.values()]
}

export function filterRows(rows: readonly TokenRow[], providerID: string, modelID: string): TokenRow[] {
  return rows.filter(
    (row) =>
      (providerID === "all" || row.providerID === providerID) &&
      (modelID === "all" || row.modelID === modelID),
  )
}

const SORT_VALUE: Record<SortKey, (row: TokenRow) => number> = {
  total: (row) => row.total,
  input: (row) => row.input,
  output: (row) => row.output,
  reasoning: (row) => row.reasoning,
  cacheRead: (row) => row.cacheRead,
  cacheWrite: (row) => row.cacheWrite,
  steps: (row) => row.steps,
  cost: (row) => row.cost,
}

export function sortRows(rows: readonly TokenRow[], key: SortKey, direction: SortDirection): TokenRow[] {
  const factor = direction === "asc" ? 1 : -1
  return [...rows].sort((left, right) => {
    const difference = (SORT_VALUE[key](left) - SORT_VALUE[key](right)) * factor
    if (difference !== 0) return difference
    return left.providerID.localeCompare(right.providerID) || left.modelID.localeCompare(right.modelID)
  })
}

export function sumRows(rows: readonly TokenRow[]): TokenTotals {
  const totals: TokenTotals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    steps: 0,
    cost: 0,
  }
  for (const row of rows) {
    totals.input += row.input
    totals.output += row.output
    totals.reasoning += row.reasoning
    totals.cacheRead += row.cacheRead
    totals.cacheWrite += row.cacheWrite
    totals.total += row.total
    totals.steps += row.steps
    totals.cost += row.cost
  }
  return totals
}

export function providerOptions(rows: readonly TokenRow[]): string[] {
  return [...new Set(rows.map((row) => row.providerID))].sort()
}

export function modelOptions(rows: readonly TokenRow[], providerID: string): string[] {
  return [
    ...new Set(
      rows.filter((row) => providerID === "all" || row.providerID === providerID).map((row) => row.modelID),
    ),
  ].sort()
}

const exactFormatter = new Intl.NumberFormat("en-US")
const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const costFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatTokens(value: number, exact: boolean): string {
  return (exact ? exactFormatter : compactFormatter).format(finite(value))
}

export function formatCost(value: number): string {
  return costFormatter.format(finite(value))
}

function formatTimestamp(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(new Date(ms))
}

export function describeRange(window: RangeWindow, timezone: string): string {
  if (window.key === "all") return "All local history"

  const end = formatTimestamp(window.to - 1, timezone)
  const label =
    window.key === "rolling"
      ? `Rolling 5h · since ${formatTimestamp(window.from ?? window.to, timezone)} (${timezone})`
      : window.key === "week"
        ? `Go week · ${formatTimestamp(window.from ?? window.to, timezone)} → ${end} (${timezone})`
        : `Subscription month · ${formatTimestamp(window.from ?? window.to, timezone)} → ${end} (${timezone})`

  return window.approximate ? `${label} · quota unavailable (fallback)` : label
}
