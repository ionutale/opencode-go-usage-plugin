import type { Account } from "./policy"

export type { Account }

export type AccountStore = {
  list: () => Promise<Account[]>
  activeID: () => Promise<string | undefined>
  key: (account: Account) => Promise<string | undefined>
  activate: (credentialID: string) => Promise<void>
}

export type AccountContext = {
  integration: {
    get: (input: { integrationID: string }) => Promise<{ data: { connections?: ReadonlyArray<unknown> } }>
    connection: {
      active: (integrationID: string) => Promise<unknown>
      resolve: (connection: unknown) => Promise<unknown>
    }
  }
  credential: { activate: (input: { credentialID: string }) => Promise<void> }
}

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

function asCredential(value: unknown): { id: string; label: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== "credential") return undefined
  if (typeof record.id !== "string" || record.id.length === 0) return undefined
  return { id: record.id, label: typeof record.label === "string" && record.label.length > 0 ? record.label : record.id }
}

export function createAccountStore(ctx: AccountContext, provider: string): AccountStore {
  let connections: ReadonlyArray<unknown> | undefined

  const load = async () => {
    if (connections) return connections
    const result = await ctx.integration.get({ integrationID: provider })
    connections = result.data.connections ?? []
    return connections
  }

  return {
    async list() {
      const entries = await load()
      return entries.flatMap((entry) => {
        const credential = asCredential(entry)
        return credential ? [{ credentialID: credential.id, label: credential.label }] : []
      })
    },

    async activeID() {
      return asCredential(await ctx.integration.connection.active(provider))?.id
    },

    async key(account) {
      const entries = await load()
      const connection = entries.find((entry) => asCredential(entry)?.id === account.credentialID)
      if (!connection) return undefined
      return extractKey(await ctx.integration.connection.resolve(connection))
    },

    async activate(credentialID) {
      await ctx.credential.activate({ credentialID })
    },
  }
}
