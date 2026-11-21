import { fetchUsage } from "../service"
import type { UsageWindows } from "../usage"

export type { UsageWindow, UsageWindows } from "../usage"

export type UsageClient = {
  read: (
    account: { credentialID: string; key: string },
    options?: { signal?: AbortSignal; fresh?: boolean },
  ) => Promise<UsageWindows>
}

export type UsageClientOptions = {
  cacheMs: number
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export function createUsageClient(options: UsageClientOptions): UsageClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const cache = new Map<string, { windows: UsageWindows; at: number }>()

  return {
    async read(account, readOptions) {
      const hit = cache.get(account.credentialID)
      if (hit && !readOptions?.fresh && now() - hit.at < options.cacheMs) return hit.windows

      const windows = await fetchUsage(account.key, { fetch: doFetch, signal: readOptions?.signal })
      cache.set(account.credentialID, { windows, at: now() })
      return windows
    },
  }
}
