import { UsageParseError, parseUsageResponse, type UsageResult } from "./usage"

export const USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage"
export const CACHE_TTL_MS = 30_000
export const STALE_MAX_AGE_MS = 300_000

export type UsageErrorType = "no_credential" | "unauthorized" | "forbidden" | "upstream"

export class UsageError extends Error {
  readonly type: UsageErrorType

  constructor(type: UsageErrorType, message: string) {
    super(message)
    this.name = "UsageError"
    this.type = type
  }
}

export type UsageServiceOptions = {
  resolveKey: () => Promise<string | undefined>
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export type UsageService = {
  get: (signal?: AbortSignal) => Promise<UsageResult>
}

export function createUsageService(options: UsageServiceOptions): UsageService {
  let cache: { result: UsageResult; at: number } | undefined
  const now = options.now ?? Date.now
  const doFetch = options.fetch ?? globalThis.fetch

  return {
    async get(signal) {
      if (cache && now() - cache.at < CACHE_TTL_MS) return cache.result

      try {
        const key = await options.resolveKey()
        if (!key) throw new UsageError("no_credential", "OpenCode Go is not connected")

        const response = await doFetch(USAGE_ENDPOINT, {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            "User-Agent": "opencode-go-usage-plugin/0.1.0",
          },
          signal,
        })

        if (response.status === 401) {
          throw new UsageError("unauthorized", "usage API rejected the OpenCode Go key (HTTP 401)")
        }
        if (response.status === 403) {
          throw new UsageError("forbidden", "usage API requires an OpenCode Go subscription (HTTP 403)")
        }
        if (!response.ok) {
          throw new UsageError("upstream", `usage API responded with HTTP ${response.status}`)
        }

        const usage = parseUsageResponse(await response.json())
        const result: UsageResult = { usage, fetchedAt: new Date(now()).toISOString() }
        cache = { result, at: now() }
        return result
      } catch (error) {
        if (signal?.aborted) throw error
        const enriched = error instanceof UsageError ? error : toUpstreamError(error)
        if (cache && now() - cache.at < STALE_MAX_AGE_MS) return { ...cache.result, stale: true }
        throw enriched
      }
    },
  }
}

function toUpstreamError(error: unknown): UsageError {
  if (error instanceof UsageParseError) {
    return new UsageError("upstream", `usage API returned an unexpected payload: ${error.message}`)
  }
  if (error instanceof Error) return new UsageError("upstream", error.message)
  return new UsageError("upstream", "usage API unreachable")
}
