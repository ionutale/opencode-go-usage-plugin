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

export const USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage"

export class UsageParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageParseError"
  }
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

export type UsageAccount = { credentialID: string; key: string }

export type UsageReadOptions = { signal?: AbortSignal; fresh?: boolean }

export type UsageClient = {
  read: (account: UsageAccount, options?: UsageReadOptions) => Promise<UsageWindows>
}

export type UsageClientOptions = {
  cacheMs: number
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  now?: () => number
  endpoint?: string
}

export function createUsageClient(options: UsageClientOptions): UsageClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const endpoint = options.endpoint ?? USAGE_ENDPOINT
  const cache = new Map<string, { windows: UsageWindows; at: number }>()

  return {
    async read(account, readOptions) {
      const hit = cache.get(account.credentialID)
      if (hit && !readOptions?.fresh && now() - hit.at < options.cacheMs) return hit.windows

      const timeout = AbortSignal.timeout(options.timeoutMs ?? 5_000)
      const signal = readOptions?.signal ? AbortSignal.any([readOptions.signal, timeout]) : timeout

      const response = await doFetch(endpoint, {
        headers: {
          Authorization: `Bearer ${account.key}`,
          Accept: "application/json",
          "User-Agent": "opencode-go-failover/0.1.0",
        },
        signal,
      })

      if (!response.ok) {
        throw new Error(`usage API responded with HTTP ${response.status}`)
      }

      const windows = parseUsageResponse(await response.json())
      cache.set(account.credentialID, { windows, at: now() })
      return windows
    },
  }
}
