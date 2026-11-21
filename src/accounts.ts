import {
  CACHE_TTL_MS,
  STALE_MAX_AGE_MS,
  UsageError,
  fetchUsage,
  toUpstreamError,
} from "./service"
import { ERROR_TEXT, type UsageWindows } from "./usage"

/** One Go credential with whatever usage could be read for it. */
export type AccountUsage = {
  credentialID: string
  label: string
  active: boolean
  usage?: UsageWindows
  /** Friendly text when the usage read failed and no cached value is usable. */
  error?: string
  fetchedAt?: string
  stale?: boolean
}

export type AccountsContext = {
  integration: {
    get: (input: { integrationID: string }) => Promise<{ data: { connections?: ReadonlyArray<unknown> } }>
    connection: {
      active: (integrationID: string) => Promise<unknown>
      resolve: (connection: unknown) => Promise<unknown>
    }
  }
}

type CredentialConnection = { id: string; label: string; connection: unknown }

export type AccountsServiceOptions = {
  provider: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export type AccountsService = {
  getAll: (signal?: AbortSignal) => Promise<{ accounts: AccountUsage[] }>
}

/** Only `credential` connections are accounts; env and OAuth entries are not. */
export function credentialConnections(connections: readonly unknown[]): CredentialConnection[] {
  const accounts: CredentialConnection[] = []
  for (const connection of connections) {
    if (typeof connection !== "object" || connection === null) continue
    const record = connection as Record<string, unknown>
    if (record.type !== "credential" || typeof record.id !== "string") continue
    accounts.push({
      id: record.id,
      label: typeof record.label === "string" && record.label.length > 0 ? record.label : record.id,
      connection,
    })
  }
  return accounts
}

/** Handles both a bare secret string and credential objects with a key-ish field. */
export function extractKey(credential: unknown): string | undefined {
  if (typeof credential === "string" && credential.length > 0) return credential
  if (typeof credential === "object" && credential !== null) {
    const record = credential as Record<string, unknown>
    for (const candidate of [record.key, record.apiKey, record.value]) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate
    }
  }
  return undefined
}

export function createAccountsService(ctx: AccountsContext, options: AccountsServiceOptions): AccountsService {
  const cache = new Map<string, { usage: UsageWindows; at: number }>()
  const now = options.now ?? Date.now
  const doFetch = options.fetch ?? globalThis.fetch

  const list = async (): Promise<CredentialConnection[]> => {
    const response = await ctx.integration.get({ integrationID: options.provider })
    return credentialConnections(response.data.connections ?? [])
  }

  const activeID = async (): Promise<string | undefined> => {
    const connection = await ctx.integration.connection.active(options.provider)
    const id = typeof connection === "object" && connection !== null ? (connection as { id?: unknown }).id : undefined
    return typeof id === "string" ? id : undefined
  }

  const load = async (
    credential: CredentialConnection,
    active: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AccountUsage> => {
    const base = { credentialID: credential.id, label: credential.label, active: credential.id === active }
    const cached = cache.get(credential.id)
    if (cached && now() - cached.at < CACHE_TTL_MS) {
      return { ...base, usage: cached.usage, fetchedAt: new Date(cached.at).toISOString() }
    }

    try {
      const key = extractKey(await ctx.integration.connection.resolve(credential.connection))
      if (!key) throw new UsageError("no_credential", "OpenCode Go is not connected")
      const usage = await fetchUsage(key, { fetch: doFetch, signal })
      cache.set(credential.id, { usage, at: now() })
      return { ...base, usage, fetchedAt: new Date(now()).toISOString() }
    } catch (error) {
      if (signal?.aborted) throw error
      const enriched = error instanceof UsageError ? error : toUpstreamError(error)
      if (cached && now() - cached.at < STALE_MAX_AGE_MS) {
        return { ...base, usage: cached.usage, fetchedAt: new Date(cached.at).toISOString(), stale: true }
      }
      return { ...base, error: ERROR_TEXT[enriched.type] ?? enriched.message }
    }
  }

  return {
    async getAll(signal) {
      const [active, credentials] = await Promise.all([activeID(), list()])
      // One account's failure must not hide the others.
      const accounts = await Promise.all(credentials.map((credential) => load(credential, active, signal)))
      return { accounts }
    },
  }
}
