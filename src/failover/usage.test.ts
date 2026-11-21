import { describe, expect, it } from "vitest"
import { createUsageClient, parseUsageResponse, USAGE_ENDPOINT, UsageParseError } from "./usage"

const SAMPLE = {
  usage: {
    rolling: { status: "ok", percent: 40, resetsAt: "2026-09-27T19:03:37.947Z" },
    weekly: { status: "ok", percent: 77, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 64, resetsAt: "2026-10-05T10:02:18.000Z" },
  },
}

type Call = { url: string; headers: Record<string, string> }

function setup(respond: () => Response = () => new Response(JSON.stringify(SAMPLE), { status: 200 })) {
  const calls: Call[] = []
  let nowMs = 1_000_000
  const client = createUsageClient({
    cacheMs: 10_000,
    now: () => nowMs,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
      return respond()
    }) as typeof fetch,
  })
  return {
    client,
    calls,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

describe("parseUsageResponse", () => {
  it("parses a valid response", () => {
    const usage = parseUsageResponse(SAMPLE)
    expect(usage.rolling.percent).toBe(40)
    expect(usage.weekly.resetsAt).toBe("2026-09-28T00:00:00.000Z")
    expect(usage.monthly.status).toBe("ok")
  })

  it("rejects a response without usage", () => {
    expect(() => parseUsageResponse({})).toThrow(UsageParseError)
  })

  it("rejects a missing window", () => {
    expect(() => parseUsageResponse({ usage: { ...SAMPLE.usage, weekly: undefined } })).toThrow(UsageParseError)
  })

  it("rejects a string percent", () => {
    const broken = { usage: { ...SAMPLE.usage, rolling: { ...SAMPLE.usage.rolling, percent: "40" } } }
    expect(() => parseUsageResponse(broken)).toThrow(UsageParseError)
  })

  it("rejects an invalid resetsAt", () => {
    const broken = { usage: { ...SAMPLE.usage, monthly: { ...SAMPLE.usage.monthly, resetsAt: "soon" } } }
    expect(() => parseUsageResponse(broken)).toThrow(UsageParseError)
  })
})

describe("createUsageClient", () => {
  it("sends the key as a bearer token to the usage endpoint", async () => {
    const { client, calls } = setup()
    await client.read({ credentialID: "cred_1", key: "secret" })
    expect(calls[0].url).toBe(USAGE_ENDPOINT)
    expect(calls[0].headers.Authorization).toBe("Bearer secret")
  })

  it("caches per credential until the cache expires", async () => {
    const { client, calls, advance } = setup()
    await client.read({ credentialID: "cred_1", key: "a" })
    await client.read({ credentialID: "cred_1", key: "a" })
    expect(calls).toHaveLength(1)

    await client.read({ credentialID: "cred_2", key: "b" })
    expect(calls).toHaveLength(2)

    advance(10_001)
    await client.read({ credentialID: "cred_1", key: "a" })
    expect(calls).toHaveLength(3)
  })

  it("bypasses the cache when fresh is true", async () => {
    const { client, calls } = setup()
    await client.read({ credentialID: "cred_1", key: "a" })
    await client.read({ credentialID: "cred_1", key: "a" }, { fresh: true })
    expect(calls).toHaveLength(2)
  })

  it("does not cache a failed read", async () => {
    let status = 401
    const { client, calls } = setup(() =>
      new Response(status === 200 ? JSON.stringify(SAMPLE) : "{}", { status }),
    )
    await expect(client.read({ credentialID: "cred_1", key: "a" })).rejects.toThrow("401")

    status = 200
    const usage = await client.read({ credentialID: "cred_1", key: "a" })
    expect(usage.rolling.percent).toBe(40)
    expect(calls).toHaveLength(2)
  })

  it("gives up on a hung request after its timeout", async () => {
    const client = createUsageClient({
      cacheMs: 10_000,
      timeoutMs: 20,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })) as typeof fetch,
    })
    await expect(client.read({ credentialID: "cred_1", key: "a" })).rejects.toThrow("aborted")
  })
})
