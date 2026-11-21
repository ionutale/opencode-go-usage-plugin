import { credentialConnections, extractKey, type CredentialConnection } from "../accounts"
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

const asAccount = (credential: CredentialConnection): Account => ({
  credentialID: credential.id,
  label: credential.label,
})

export function createAccountStore(ctx: AccountContext, provider: string): AccountStore {
  // Re-list on every use: credentials can be added or removed while the server
  // runs, and a transient empty response must not disable failover forever.
  const load = async (): Promise<CredentialConnection[]> => {
    const result = await ctx.integration.get({ integrationID: provider })
    return credentialConnections(result.data.connections ?? [])
  }

  return {
    async list() {
      return (await load()).map(asAccount)
    },

    async activeID() {
      const active = await ctx.integration.connection.active(provider)
      return credentialConnections([active])[0]?.id
    },

    async key(account) {
      const connection = (await load()).find((entry) => entry.id === account.credentialID)
      if (!connection) return undefined
      return extractKey(await ctx.integration.connection.resolve(connection.connection))
    },

    async activate(credentialID) {
      await ctx.credential.activate({ credentialID })
    },
  }
}
