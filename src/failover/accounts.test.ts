import { describe, expect, it, vi } from "vitest"
import { createAccountStore, extractKey, type AccountContext } from "./accounts"

const CONNECTIONS = [
  { type: "credential", id: "cred_1", label: "Work", method: "key" },
  { type: "credential", id: "cred_2", label: "Personal", method: "key" },
  { type: "env", name: "OPENCODE_API_KEY" },
]

function fakeCtx(input: {
  connections?: ReadonlyArray<unknown>
  active?: unknown
  resolved?: unknown
} = {}) {
  const activate = vi.fn(async () => {})
  const ctx: AccountContext = {
    integration: {
      get: async () => ({ data: { connections: input.connections ?? CONNECTIONS } }),
      connection: {
        active: async () => input.active,
        resolve: async () => input.resolved,
      },
    },
    credential: { activate },
  }
  return { ctx, activate }
}

describe("createAccountStore", () => {
  it("lists only credential connections", async () => {
    const { ctx } = fakeCtx()
    const store = createAccountStore(ctx, "opencode-go")
    expect(await store.list()).toEqual([
      { credentialID: "cred_1", label: "Work" },
      { credentialID: "cred_2", label: "Personal" },
    ])
  })

  it("returns an empty list when the integration exposes nothing", async () => {
    const { ctx } = fakeCtx({ connections: [] })
    const store = createAccountStore(ctx, "opencode-go")
    expect(await store.list()).toEqual([])
  })

  it("reads the active credential id", async () => {
    const { ctx } = fakeCtx({ active: { type: "credential", id: "cred_1", label: "Work", method: "key" } })
    const store = createAccountStore(ctx, "opencode-go")
    expect(await store.activeID()).toBe("cred_1")
  })

  it("returns undefined when the active connection is env-based", async () => {
    const { ctx } = fakeCtx({ active: { type: "env", name: "OPENCODE_API_KEY" } })
    const store = createAccountStore(ctx, "opencode-go")
    expect(await store.activeID()).toBeUndefined()
  })

  it("resolves a key from a string or a key object", async () => {
    const first = fakeCtx({ resolved: "sk-plain" })
    expect(await createAccountStore(first.ctx, "opencode-go").key({ credentialID: "cred_1", label: "Work" })).toBe("sk-plain")

    const second = fakeCtx({ resolved: { type: "api", key: "sk-object" } })
    expect(await createAccountStore(second.ctx, "opencode-go").key({ credentialID: "cred_1", label: "Work" })).toBe(
      "sk-object",
    )
  })

  it("returns undefined when resolve returns nothing", async () => {
    const { ctx } = fakeCtx({ resolved: undefined })
    expect(await createAccountStore(ctx, "opencode-go").key({ credentialID: "cred_1", label: "Work" })).toBeUndefined()
  })

  it("activates by credential id", async () => {
    const { ctx, activate } = fakeCtx()
    await createAccountStore(ctx, "opencode-go").activate("cred_2")
    expect(activate).toHaveBeenCalledWith({ credentialID: "cred_2" })
  })
})

describe("extractKey", () => {
  it("accepts a bare string and key-ish fields", () => {
    expect(extractKey("sk-test")).toBe("sk-test")
    expect(extractKey({ key: "sk-test" })).toBe("sk-test")
    expect(extractKey({ apiKey: "sk-test" })).toBe("sk-test")
    expect(extractKey({ value: "sk-test" })).toBe("sk-test")
  })

  it("returns undefined for unknown shapes", () => {
    expect(extractKey(undefined)).toBeUndefined()
    expect(extractKey({})).toBeUndefined()
    expect(extractKey({ key: 42 })).toBeUndefined()
  })
})
