import {
  USAGE_ENDPOINT,
  USER_AGENT,
  UsageParseError,
  parseUsageResponse,
  type UsageErrorType,
  type UsageResult,
  type UsageWindows,
} from "./usage"

export const CACHE_TTL_MS = 15_000
export const STALE_MAX_AGE_MS = 300_000
export const REQUEST_TIMEOUT_MS = 5_000
export const MAX_BODY_BYTES = 512 * 1024

export class UsageError extends Error {
  readonly type: UsageErrorType

  constructor(type: UsageErrorType, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "UsageError"
    this.type = type
  }
}

/** Reads a response body with a hard size cap so a hostile endpoint cannot exhaust memory. */
async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new UsageError("upstream", "usage API response too large")
  }
  if (!response.body) return response.json()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new UsageError("upstream", "usage API response too large")
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** One usage read for one key. Throws `UsageError` for anything a caller can report. */
export async function fetchUsage(
  key: string,
  options: { fetch: typeof globalThis.fetch; signal?: AbortSignal },
): Promise<UsageWindows> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

  const response = await options.fetch(USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal,
    redirect: "error",
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

  return parseUsageResponse(await readJson(response))
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
  // The cache is keyed by the resolved credential, so activating another account
  // cannot leave the previous account's usage on screen.
  let cache: { key: string; result: UsageResult; at: number } | undefined
  const now = options.now ?? Date.now
  const doFetch = options.fetch ?? globalThis.fetch

  return {
    async get(signal) {
      const key = await options.resolveKey()
      if (!key) throw new UsageError("no_credential", "OpenCode Go is not connected")
      if (cache && cache.key === key && now() - cache.at < CACHE_TTL_MS) return cache.result

      try {
        const usage = await fetchUsage(key, { fetch: doFetch, signal })
        const result: UsageResult = { usage, fetchedAt: new Date(now()).toISOString() }
        cache = { key, result, at: now() }
        return result
      } catch (error) {
        if (signal?.aborted) throw error
        const enriched = error instanceof UsageError ? error : toUpstreamError(error)
        if (cache && cache.key === key && now() - cache.at < STALE_MAX_AGE_MS) {
          return { ...cache.result, stale: true }
        }
        throw enriched
      }
    },
  }
}

export function toUpstreamError(error: unknown): UsageError {
  if (error instanceof UsageParseError) {
    return new UsageError("upstream", `usage API returned an unexpected payload: ${error.message}`, { cause: error })
  }
  if (error instanceof UsageError) return error
  const message = error instanceof Error ? error.message : "usage API unreachable"
  return new UsageError("upstream", message, { cause: error })
}
