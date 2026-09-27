import { afterEach, describe, expect, it, vi } from "vitest"
import plugin, { extractKey } from "./index"

const SAMPLE = {
  usage: {
    rolling: { status: "ok", percent: 40, resetsAt: "2026-09-27T19:03:37.947Z" },
    weekly: { status: "ok", percent: 77, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 64, resetsAt: "2026-10-05T10:02:18.000Z" },
  },
}

type Registered = {
  definition?: { id?: string }
  implementation?: { get: (input: unknown, context: unknown) => Promise<unknown> }
}

function fakeCtx(credential: unknown) {
  const registered: Registered = {}
  const ctx = {
    integration: {
      connection: {
        active: async (id: string) => (id === "opencode-go" ? { id: "conn-1" } : undefined),
        resolve: async () => credential,
      },
    },
    rpc: {
      register: async (definition: unknown, implementation: unknown) => {
        registered.definition = definition as Registered["definition"]
        registered.implementation = implementation as Registered["implementation"]
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, registered }
}

async function invokeGet(credential: unknown) {
  const { ctx, registered } = fakeCtx(credential)
  await (plugin as unknown as { setup: (ctx: unknown) => Promise<void> }).setup(ctx)
  const get = registered.implementation!.get
  const result = await get(undefined, {
    signal: undefined,
    error: (type: string, message: string, data: unknown) => ({ error: { type, message, data } }),
  })
  return result
}

afterEach(() => vi.unstubAllGlobals())

describe("server plugin", () => {
  it("registers the go-usage RPC", async () => {
    const { ctx, registered } = fakeCtx("key")
    await (plugin as unknown as { setup: (ctx: unknown) => Promise<void> }).setup(ctx)
    expect(registered.definition?.id).toBe("go-usage")
    expect(typeof registered.implementation?.get).toBe("function")
  })

  it("returns parsed usage on success", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const result = (await invokeGet({ type: "api", key: "test-key" })) as { usage?: { rolling?: { percent?: number } } }
    expect(result.usage?.rolling?.percent).toBe(40)
  })

  it("maps a 401 to the declared unauthorized error with friendly text", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }))
    const result = (await invokeGet("bad-key")) as { error?: { type: string; message: string; data: unknown } }
    expect(result.error?.type).toBe("unauthorized")
    expect(result.error?.message).toBe("check API key")
    expect(result.error?.data).toEqual({ message: "usage API rejected the OpenCode Go key (HTTP 401)" })
  })

  it("maps a missing connection to no_credential", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const result = (await invokeGet(undefined)) as { error?: { type: string; message: string } }
    expect(result.error?.type).toBe("no_credential")
    expect(result.error?.message).toBe("not connected")
  })
})

describe("extractKey", () => {
  it("accepts a bare string", () => {
    expect(extractKey("sk-test")).toBe("sk-test")
  })

  it("accepts key/apiKey/value fields", () => {
    expect(extractKey({ type: "api", key: "sk-test" })).toBe("sk-test")
    expect(extractKey({ apiKey: "sk-test" })).toBe("sk-test")
    expect(extractKey({ value: "sk-test" })).toBe("sk-test")
  })

  it("returns undefined for unknown shapes", () => {
    expect(extractKey(undefined)).toBeUndefined()
    expect(extractKey({})).toBeUndefined()
    expect(extractKey({ key: 42 })).toBeUndefined()
  })
})
