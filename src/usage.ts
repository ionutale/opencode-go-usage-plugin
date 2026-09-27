export type UsageWindow = {
  status: string
  percent: number
  resetsAt: string
}

export type UsageWindows = {
  rolling: UsageWindow
  weekly: UsageWindow
  monthly: UsageWindow
}

export type UsageResult = {
  usage: UsageWindows
  /** ISO timestamp of the last successful upstream fetch */
  fetchedAt: string
  /** True when this is cached data served after a failed refresh */
  stale?: boolean
}

export class UsageParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageParseError"
  }
}

export const GREEN = "#22c55e"
export const YELLOW = "#eab308"
export const RED = "#ef4444"

export const ERROR_TEXT: Record<string, string> = {
  no_credential: "not connected",
  unauthorized: "check API key",
  forbidden: "Go plan required",
  upstream: "unreachable",
}

const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const

function parseWindow(value: unknown, key: string): UsageWindow {
  if (typeof value !== "object" || value === null) throw new UsageParseError(`usage.${key} is not an object`)
  const record = value as Record<string, unknown>
  if (typeof record.status !== "string") throw new UsageParseError(`usage.${key}.status is not a string`)
  if (typeof record.percent !== "number" || !Number.isFinite(record.percent)) {
    throw new UsageParseError(`usage.${key}.percent is not a number`)
  }
  if (typeof record.resetsAt !== "string" || Number.isNaN(Date.parse(record.resetsAt))) {
    throw new UsageParseError(`usage.${key}.resetsAt is not a valid date`)
  }
  return { status: record.status, percent: record.percent, resetsAt: record.resetsAt }
}

export function parseUsageResponse(input: unknown): UsageWindows {
  if (typeof input !== "object" || input === null) throw new UsageParseError("response is not an object")
  const usage = (input as Record<string, unknown>).usage
  if (typeof usage !== "object" || usage === null) throw new UsageParseError("response.usage is missing")
  const record = usage as Record<string, unknown>
  const result = {} as UsageWindows
  for (const key of WINDOW_KEYS) result[key] = parseWindow(record[key], key)
  return result
}

/** Remaining time as `Xd Yh`, `Xh Ym`, or `Xm`. Past or invalid values clamp to `0m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m"
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatResetsIn(resetsAt: string, nowMs: number): string {
  const target = Date.parse(resetsAt)
  if (Number.isNaN(target)) return "0m"
  return formatDuration(target - nowMs)
}

/** Filled/empty bar segments, e.g. `barSegments(40)` -> `████░░░░░░`. */
export function barSegments(percent: number, width = 10): string {
  const bounded = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  const filled = Math.min(width, Math.max(0, Math.round((bounded / 100) * width)))
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function usageColor(percent: number): string {
  if (percent >= 75) return RED
  if (percent >= 50) return YELLOW
  return GREEN
}

/** Maps an RPC error to short UI text. Accepts unprefixed or `rpc.<id>.`-prefixed types. */
export function describeRpcError(error: unknown): string {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined
  const data =
    typeof record?.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : undefined
  const rawType =
    typeof record?.type === "string" ? record.type : typeof data?.type === "string" ? data.type : undefined
  if (rawType) {
    const normalized = rawType.replace(/^rpc\.[^.]+\./, "")
    const known = ERROR_TEXT[normalized]
    if (known) return known
  }
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof record?.message === "string" && record.message.length > 0) return record.message
  if (typeof data?.message === "string" && data.message.length > 0) return data.message
  return ERROR_TEXT.upstream
}

/** One aligned row per window, in the same shape the sidebar renders and the smoke script prints. */
export function formatUsageRows(result: UsageResult, nowMs: number): string[] {
  return WINDOW_KEYS.map((key) => {
    const window = result.usage[key]
    const label = `${key[0].toUpperCase()}${key.slice(1)}`
    const percent = String(Math.round(window.percent)).padStart(3)
    return `${label.padEnd(8)} ${barSegments(window.percent)}  ${percent}%  ${formatResetsIn(window.resetsAt, nowMs)}`
  })
}
