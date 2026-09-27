import { afterEach, describe, expect, it, vi } from "vitest"
import { CACHE_TTL_MS, STALE_MAX_AGE_MS, UsageError, createUsageService } from "./service"

const SAMPLE = {
  usage: {
    rolling: { status: "ok", percent: 40, resetsAt: "2026-09-27T19:03:37.947Z" },
    weekly: { status: "ok", percent: 77, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 64, resetsAt: "2026-10-05T10:02:18.000Z" },
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function makeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    if (next instanceof Error) throw next
    if (!next) throw new Error("no more fake responses")
    return next
  })
  return { fn: fn as unknown as typeof globalThis.fetch, calls }
}

function makeService(
  resolveKey: () => Promise<string | undefined>,
  responses: Array<Response | Error>,
  startTime = 1_000_000,
) {
  const { fn, calls } = makeFetch(responses)
  let now = startTime
  const service = createUsageService({ resolveKey, fetch: fn, now: () => now })
  return { service, calls, advance: (ms: number) => (now += ms) }
}

afterEach(() => vi.useRealTimers())

describe("createUsageService", () => {
  it("fetches, authorizes, and returns parsed usage", async () => {
    const { service, calls } = makeService(async () => "test-key", [jsonResponse(SAMPLE)])
    const result = await service.get()
    expect(result.usage.rolling.percent).toBe(40)
    expect(result.stale).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://opencode.ai/zen/go/v1/usage")
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key")
  })

  it("serves from cache within the TTL", async () => {
    const { service, calls, advance } = makeService(async () => "test-key", [jsonResponse(SAMPLE)])
    const first = await service.get()
    advance(CACHE_TTL_MS - 1)
    const second = await service.get()
    expect(calls).toHaveLength(1)
    expect(second.fetchedAt).toBe(first.fetchedAt)
  })

  it("refetches after the TTL", async () => {
    const { service, calls, advance } = makeService(async () => "test-key", [
      jsonResponse(SAMPLE),
      jsonResponse(SAMPLE),
    ])
    await service.get()
    advance(CACHE_TTL_MS + 1)
    await service.get()
    expect(calls).toHaveLength(2)
  })

  it("maps HTTP 401 to unauthorized", async () => {
    const { service } = makeService(async () => "bad-key", [jsonResponse({}, 401)])
    await expect(service.get()).rejects.toMatchObject({ type: "unauthorized" })
  })

  it("maps HTTP 403 to forbidden", async () => {
    const { service } = makeService(async () => "key", [jsonResponse({}, 403)])
    await expect(service.get()).rejects.toMatchObject({ type: "forbidden" })
  })

  it("maps a non-JSON body to upstream", async () => {
    const { service } = makeService(async () => "key", [new Response("<html>portal</html>", { status: 200 })])
    await expect(service.get()).rejects.toMatchObject({ type: "upstream" })
  })

  it("reports no_credential when no key resolves", async () => {
    const { service } = makeService(async () => undefined, [jsonResponse(SAMPLE)])
    await expect(service.get()).rejects.toMatchObject({ type: "no_credential" })
  })

  it("serves stale data within five minutes of a failed refresh", async () => {
    const { service, calls, advance } = makeService(async () => "key", [
      jsonResponse(SAMPLE),
      new Error("network down"),
    ])
    const first = await service.get()
    advance(CACHE_TTL_MS + 1)
    const second = await service.get()
    expect(calls).toHaveLength(2)
    expect(second.stale).toBe(true)
    expect(second.fetchedAt).toBe(first.fetchedAt)
  })

  it("rejects when the failure outlasts the stale window", async () => {
    const { service, advance } = makeService(async () => "key", [jsonResponse(SAMPLE), new Error("network down")])
    await service.get()
    advance(STALE_MAX_AGE_MS + 1)
    await expect(service.get()).rejects.toMatchObject({ type: "upstream" })
  })

  it("rethrows aborted requests without serving stale data", async () => {
    const { service, advance } = makeService(async () => "key", [
      jsonResponse(SAMPLE),
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    ])
    await service.get()
    advance(CACHE_TTL_MS + 1)
    const controller = new AbortController()
    controller.abort()
    await expect(service.get(controller.signal)).rejects.toThrow("aborted")
  })
})

describe("UsageError", () => {
  it("carries its type", () => {
    const error = new UsageError("forbidden", "nope")
    expect(error.type).toBe("forbidden")
    expect(error.message).toBe("nope")
    expect(error).toBeInstanceOf(Error)
  })
})
