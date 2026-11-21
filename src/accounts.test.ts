import { describe, expect, it } from "vitest"
import { createAccountsService, credentialConnections, extractKey, type AccountsContext } from "./accounts"

const SAMPLE = {
  usage: {
    rolling: { status: "ok", percent: 40, resetsAt: "2026-09-27T19:03:37.947Z" },
    weekly: { status: "ok", percent: 77, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 64, resetsAt: "2026-10-05T10:02:18.000Z" },
  },
}

const CONNECTIONS = [
  { type: "credential", id: "cred_1", label: "Work" },
  { type: "credential", id: "cred_2", label: "Personal" },
  { type: "credential", id: "cred_3", label: "Backup" },
  { type: "env", name: "OPENCODE_API_KEY" },
]

function fakeContext(input: {
  connections?: ReadonlyArray<unknown>
  active?: string
  keys?: Record<string, unknown>
}) {
  const connections = input.connections ?? CONNECTIONS
  const keys = input.keys ?? { cred_1: "test-key-1", cred_2: "test-key-2", cred_3: "test-key-3" }
  const ctx: AccountsContext = {
    integration: {
      get: async () => ({ data: { connections } }),
      connection: {
        active: async () => connections.find((entry: any) => entry.type === "credential" && entry.id === input.active),
        resolve: async (connection: any) => keys[connection.id],
      },
    },
  }
  return ctx
}

function stubFetch(handler: (key: string) => Response) {
  const keys: string[] = []
  const fetch = async (_url: string, init?: RequestInit) => {
    const key = (init?.headers as Record<string, string>).Authorization.replace("Bearer ", "")
    keys.push(key)
    return handler(key)
  }
  return { fetch: fetch as typeof globalThis.fetch, keys }
}

describe("credentialConnections", () => {
  it("keeps credentials and ignores env entries", () => {
    expect(credentialConnections(CONNECTIONS).map((entry) => entry.id)).toEqual(["cred_1", "cred_2", "cred_3"])
  })

  it("falls back to the id for a missing label", () => {
    expect(credentialConnections([{ type: "credential", id: "cred_x" }])[0]).toMatchObject({
      id: "cred_x",
      label: "cred_x",
    })
  })
})

describe("extractKey", () => {
  it("accepts a bare string and key-shaped objects", () => {
    expect(extractKey("oc_sk")).toBe("oc_sk")
    expect(extractKey({ key: "oc_sk" })).toBe("oc_sk")
    expect(extractKey({ apiKey: "oc_sk" })).toBe("oc_sk")
    expect(extractKey({ value: "oc_sk" })).toBe("oc_sk")
  })

  it("returns undefined for nothing usable", () => {
    expect(extractKey(undefined)).toBeUndefined()
    expect(extractKey({})).toBeUndefined()
    expect(extractKey({ key: "" })).toBeUndefined()
  })
})

describe("createAccountsService", () => {
  it("lists every credential, marks the active one, and fetches per key", async () => {
    const { fetch, keys } = stubFetch(() => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const service = createAccountsService(fakeContext({ active: "cred_2" }), { provider: "opencode-go", fetch })

    const { accounts } = await service.getAll()

    expect(accounts.map((account) => account.label)).toEqual(["Work", "Personal", "Backup"])
    expect(accounts.filter((account) => account.active).map((account) => account.credentialID)).toEqual(["cred_2"])
    expect(accounts.every((account) => account.usage?.weekly.percent === 77)).toBe(true)
    expect(keys.sort()).toEqual(["test-key-1", "test-key-2", "test-key-3"])
  })

  it("keeps the other accounts when one read fails", async () => {
    const service = createAccountsService(fakeContext({ active: "cred_1" }), {
      provider: "opencode-go",
      fetch: async (_url, init) => {
        const key = (init?.headers as Record<string, string>).Authorization
        return key === "Bearer test-key-2"
          ? new Response("{}", { status: 401 })
          : new Response(JSON.stringify(SAMPLE), { status: 200 })
      },
    })

    const { accounts } = await service.getAll()

    expect(accounts).toHaveLength(3)
    expect(accounts.find((account) => account.credentialID === "cred_2")).toMatchObject({ error: "check API key" })
    expect(accounts.find((account) => account.credentialID === "cred_1")?.usage?.rolling.percent).toBe(40)
    expect(accounts.find((account) => account.credentialID === "cred_3")?.usage?.monthly.percent).toBe(64)
  })

  it("reports a missing key without dropping the account", async () => {
    const service = createAccountsService(fakeContext({ active: "cred_1", keys: { cred_1: "test-key-1" } }), {
      provider: "opencode-go",
      fetch: async () => new Response(JSON.stringify(SAMPLE), { status: 200 }),
    })

    const { accounts } = await service.getAll()

    expect(accounts.find((account) => account.credentialID === "cred_2")).toMatchObject({ error: "not connected" })
    expect(accounts).toHaveLength(3)
  })

  it("caches each credential until the TTL", async () => {
    let clock = 1_000
    const { fetch, keys } = stubFetch(() => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const service = createAccountsService(fakeContext({ active: "cred_1" }), {
      provider: "opencode-go",
      fetch,
      now: () => clock,
    })

    await service.getAll()
    const first = keys.length
    clock += 1_000
    await service.getAll()

    expect(keys.length).toBe(first)
  })

  it("serves a stale cached value when a refresh fails", async () => {
    let clock = 1_000
    let fail = false
    const { fetch } = stubFetch(() =>
      fail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(SAMPLE), { status: 200 }),
    )
    const service = createAccountsService(fakeContext({ active: "cred_1" }), {
      provider: "opencode-go",
      fetch,
      now: () => clock,
    })

    await service.getAll()
    fail = true
    clock += 60_000
    const { accounts } = await service.getAll()

    expect(accounts[0].usage?.rolling.percent).toBe(40)
    expect(accounts[0].stale).toBe(true)
    expect(accounts[0].error).toBeUndefined()
  })
})
