import { afterEach, describe, expect, it, vi } from "vitest"
import { failover } from "./index"

const HOUR = 3_600_000

type UsageResponse = {
  usage: {
    rolling: { status: string; percent: number; resetsAt: string }
    weekly: { status: string; percent: number; resetsAt: string }
    monthly: { status: string; percent: number; resetsAt: string }
  }
}

function usagePayload(
  rolling: number,
  options: { blocked?: boolean; resetInMs?: number; resetAllMs?: number; monthlyResetMs?: number } = {},
): UsageResponse {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString()
  const all = options.resetAllMs
  return {
    usage: {
      rolling: {
        status: options.blocked ? "exhausted" : "ok",
        percent: rolling,
        resetsAt: at(all ?? options.resetInMs ?? HOUR),
      },
      weekly: { status: "ok", percent: Math.max(0, rolling - 1), resetsAt: at(all ?? 2 * HOUR) },
      monthly: { status: "ok", percent: Math.max(0, rolling - 2), resetsAt: at(all ?? options.monthlyResetMs ?? 72 * HOUR) },
    },
  }
}

const CONNECTIONS = [
  { type: "credential", id: "cred_1", label: "Work", method: "key" },
  { type: "credential", id: "cred_2", label: "Personal", method: "key" },
  { type: "credential", id: "cred_3", label: "Backup", method: "key" },
]

type Hook = { name: string; callback: (event: unknown) => Promise<void> | void; options?: { providerID?: string } }

function fakeContext(input: {
  usage: Record<string, UsageResponse>
  active?: string
  options?: Record<string, unknown>
  connections?: ReadonlyArray<unknown>
  sessionModel?: string | null
}) {
  let active = input.active ?? "cred_1"
  const hooks: Hook[] = []
  const activated: string[] = []
  const synthetic: string[] = []
  const connections = input.connections ?? CONNECTIONS

  const ctx = {
    options: { logFile: "/tmp/opencode-go-failover-test.log", ...(input.options ?? {}) },
    integration: {
      get: async () => ({ data: { connections } }),
      connection: {
        active: async () => connections.find((entry: any) => entry.type === "credential" && entry.id === active),
        resolve: async (connection: { id: string }) => ({ type: "api", key: connection.id }),
      },
    },
    credential: {
      activate: async ({ credentialID }: { credentialID: string }) => {
        active = credentialID
        activated.push(credentialID)
      },
    },
    session: {
      hook: async (name: string, callback: Hook["callback"], options?: Hook["options"]) => {
        hooks.push({ name, callback, options })
        return { dispose: async () => {} }
      },
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        model:
          input.sessionModel === null
            ? undefined
            : { providerID: input.sessionModel ?? "opencode-go", id: "deepseek-v4.1-flash" },
      }),
      synthetic: async ({ text }: { text: string }) => {
        synthetic.push(text)
      },
    },
  }

  return {
    ctx,
    activated,
    synthetic,
    hooks,
    hook: (name: string) => hooks.find((entry) => entry.name === name)?.callback,
  }
}

function stubUsage(usage: Record<string, UsageResponse>) {
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string>).Authorization
    const id = header.replace("Bearer ", "")
    const payload = usage[id] ?? usagePayload(0)
    return new Response(JSON.stringify(payload), { status: 200 })
  })
}

async function setup(input: Parameters<typeof fakeContext>[0]) {
  const fake = fakeContext(input)
  stubUsage(input.usage)
  await (failover as unknown as { setup: (ctx: unknown) => Promise<void> | void }).setup(fake.ctx)
  return fake
}

function retryEvent(error: { type: string; message: string; status?: number }, attempt = 1) {
  return {
    sessionID: "ses_1",
    agent: "build",
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    error,
    attempt,
    decision: { retry: false as const } as { retry: boolean; delay?: number },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe("hook registration", () => {
  it("registers a provider-scoped retry hook and a prompt hook", async () => {
    const fake = await setup({ usage: {} })
    expect(fake.hook("retry")).toBeTypeOf("function")
    expect(fake.hook("prompt")).toBeTypeOf("function")
    expect(fake.hooks.find((entry) => entry.name === "retry")?.options?.providerID).toBe("opencode-go")
  })
})

describe("reactive failover", () => {
  it("rotates to the account whose plan renews soonest, even with less headroom", async () => {
    const fake = await setup({
      usage: {
        cred_1: usagePayload(100, { blocked: true, resetAllMs: HOUR }),
        cred_2: usagePayload(20, { monthlyResetMs: 72 * HOUR }),
        cred_3: usagePayload(60, { monthlyResetMs: 24 * HOUR }),
      },
    })
    const event = retryEvent({ type: "provider.rate-limit", message: "usage limit reached", status: 429 })
    await fake.hook("retry")!(event)
    expect(fake.activated).toEqual(["cred_3"])
    expect(event.decision).toEqual({ retry: true, delay: 0 })
  })

  it("rotates to the account with the most headroom when renewals tie", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(100, { blocked: true }), cred_2: usagePayload(20), cred_3: usagePayload(90) },
    })
    const event = retryEvent({ type: "provider.rate-limit", message: "usage limit reached", status: 429 })
    await fake.hook("retry")!(event)
    expect(fake.activated).toEqual(["cred_2"])
    expect(event.decision).toEqual({ retry: true, delay: 0 })
  })

  it("does not rotate on a bare 429 when the active account is far from its limit", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(40), cred_2: usagePayload(10), cred_3: usagePayload(5) },
    })
    const event = retryEvent({ type: "provider.rate-limit", message: "RateLimitExceeded", status: 429 })
    await fake.hook("retry")!(event)
    expect(fake.activated).toEqual([])
    expect(event.decision).toEqual({ retry: false })
  })

  it("still rotates on a named Go limit at 429, even below the threshold", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(40), cred_2: usagePayload(30), cred_3: usagePayload(20) },
    })
    const event = retryEvent({ type: "provider.go-limit", message: "usage limit reached", status: 429 })
    await fake.hook("retry")!(event)
    expect(fake.activated).toEqual(["cred_3"])
    expect(event.decision).toEqual({ retry: true, delay: 0 })
  })

  it("still rotates on a bare 429 when the active account is blocked", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(100, { blocked: true }), cred_2: usagePayload(10), cred_3: usagePayload(20) },
    })
    const event = retryEvent({ type: "provider.rate-limit", message: "RateLimitExceeded", status: 429 })
    await fake.hook("retry")!(event)
    expect(fake.activated).toHaveLength(1)
    expect(event.decision).toEqual({ retry: true, delay: 0 })
  })

  it("leaves the decision alone for a non-limit error", async () => {
    const fake = await setup({ usage: { cred_1: usagePayload(40), cred_2: usagePayload(10) } })
    const event = retryEvent({ type: "provider.invalid-request", message: "bad tool schema", status: 400 })
    await fake.hook("retry")!(event)
    expect(fake.activated).toEqual([])
    expect(event.decision).toEqual({ retry: false })
  })

  it("waits for the soonest reset when every account is blocked", async () => {
    const fake = await setup({
      usage: {
        cred_1: usagePayload(100, { blocked: true, resetInMs: HOUR }),
        cred_2: usagePayload(100, { blocked: true, resetInMs: 2 * HOUR }),
        cred_3: usagePayload(100, { blocked: true, resetInMs: 3 * HOUR }),
      },
    })
    const event = retryEvent({ type: "provider.rate-limit", message: "weekly limit reached" })
    await fake.hook("retry")!(event)
    expect(fake.activated).toEqual([])
    expect(event.decision.retry).toBe(true)
    expect(event.decision.delay).toBeGreaterThanOrEqual(HOUR)
    expect(event.decision.delay).toBeLessThan(HOUR + 10_000)
  })

  it("does not rotate to the same account twice in one turn", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(100, { blocked: true }), cred_2: usagePayload(90), cred_3: usagePayload(20) },
    })
    const retry = fake.hook("retry")!
    const first = retryEvent({ type: "provider.rate-limit", message: "limit reached" })
    await retry(first)
    expect(fake.activated).toEqual(["cred_3"])

    const second = retryEvent({ type: "provider.rate-limit", message: "limit reached" }, 2)
    await retry(second)
    expect(fake.activated).toEqual(["cred_3", "cred_2"])

    const third = retryEvent({ type: "provider.rate-limit", message: "limit reached" }, 3)
    await retry(third)
    expect(fake.activated).toEqual(["cred_3", "cred_2"])
    // Every account was tried and usage still calls some available: waiting
    // cannot help, so the error surfaces instead of a buffer-only retry.
    expect(third.decision).toEqual({ retry: false })
  })

  it("does not throw when usage lookups fail", async () => {
    const fake = fakeContext({ usage: {} })
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down")
    })
    await (failover as unknown as { setup: (ctx: unknown) => Promise<void> | void }).setup(fake.ctx)
    const event = retryEvent({ type: "provider.rate-limit", message: "limit reached" })
    await expect(fake.hook("retry")!(event)).resolves.toBeUndefined()
  })
})

describe("failure isolation", () => {
  it("still rotates when one account's usage cannot be read", async () => {
    const usage = { cred_1: usagePayload(100, { blocked: true }), cred_2: usagePayload(10), cred_3: usagePayload(50) }
    const fake = fakeContext({ usage })
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>).Authorization.replace("Bearer ", "")
      if (key === "cred_1") throw new Error("401 from one account")
      return new Response(JSON.stringify(usage[key as keyof typeof usage]), { status: 200 })
    })
    await (failover as unknown as { setup: (ctx: unknown) => Promise<void> | void }).setup(fake.ctx)
    const event = retryEvent({ type: "provider.rate-limit", message: "usage limit reached" })
    await fake.hook("retry")!(event)
    expect(fake.activated).toEqual(["cred_2"])
  })

  it("does nothing when only one credential is saved", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(40) },
      connections: [CONNECTIONS[0]],
      options: { proactiveThreshold: 1 },
    })
    await fake.hook("prompt")!({ sessionID: "ses_1" })
    const event = retryEvent({ type: "provider.rate-limit", message: "usage limit reached" })
    await fake.hook("retry")!(event)
    expect(fake.activated).toEqual([])
  })
})

describe("degraded mode", () => {
  it("rotates at most once per account per turn and then surfaces the error", async () => {
    const fake = fakeContext({ usage: {} })
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down")
    })
    await (failover as unknown as { setup: (ctx: unknown) => Promise<void> | void }).setup(fake.ctx)
    const retry = fake.hook("retry")!

    const first = retryEvent({ type: "provider.rate-limit", message: "usage limit reached" }, 1)
    await retry(first)
    const second = retryEvent({ type: "provider.rate-limit", message: "usage limit reached" }, 2)
    await retry(second)
    const third = retryEvent({ type: "provider.rate-limit", message: "usage limit reached" }, 3)
    await retry(third)
    const fourth = retryEvent({ type: "provider.rate-limit", message: "usage limit reached" }, 4)
    await retry(fourth)

    expect(fake.activated).toEqual(["cred_2", "cred_3"])
    expect(third.decision).toEqual({ retry: false })
    expect(fourth.decision).toEqual({ retry: false })
  })

  it("surfaces instead of waiting when every account was tried and usage still looks available", async () => {
    const fake = await setup({
      usage: {
        cred_1: usagePayload(100, { blocked: true }),
        cred_2: usagePayload(20),
        cred_3: usagePayload(60),
      },
    })
    const retry = fake.hook("retry")!

    const first = retryEvent({ type: "provider.rate-limit", message: "limit reached" }, 1)
    await retry(first)
    const second = retryEvent({ type: "provider.rate-limit", message: "limit reached" }, 2)
    await retry(second)
    const third = retryEvent({ type: "provider.rate-limit", message: "limit reached" }, 3)
    await retry(third)

    expect(fake.activated).toHaveLength(2)
    expect(third.decision).toEqual({ retry: false })
  })
})

describe("notifications", () => {
  it("announces a reactive switch when notify is on", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(100, { blocked: true }), cred_2: usagePayload(10), cred_3: usagePayload(90) },
      options: { notify: true },
    })
    const event = retryEvent({ type: "provider.rate-limit", message: "usage limit reached" })
    await fake.hook("retry")!(event)
    expect(fake.synthetic).toHaveLength(1)
    expect(fake.synthetic[0]).toContain("Personal")
  })

  it("stays quiet when notify is off", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(100, { blocked: true }), cred_2: usagePayload(10), cred_3: usagePayload(90) },
    })
    const event = retryEvent({ type: "provider.rate-limit", message: "usage limit reached" })
    await fake.hook("retry")!(event)
    expect(fake.synthetic).toEqual([])
  })
})

describe("proactive switching", () => {
  it("switches on prompt admission above the threshold", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(40), cred_2: usagePayload(5), cred_3: usagePayload(2) },
      options: { proactiveThreshold: 10 },
    })
    await fake.hook("prompt")!({ sessionID: "ses_1" })
    expect(fake.activated).toEqual(["cred_3"])
  })

  it("does nothing proactively when the active account is below the threshold", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(40), cred_2: usagePayload(5), cred_3: usagePayload(2) },
      options: { proactiveThreshold: 90 },
    })
    await fake.hook("prompt")!({ sessionID: "ses_1" })
    expect(fake.activated).toEqual([])
  })

  it("does not switch proactively for a session on another provider", async () => {
    const fake = await setup({
      usage: { cred_1: usagePayload(40), cred_2: usagePayload(5), cred_3: usagePayload(2) },
      options: { proactiveThreshold: 10 },
      sessionModel: "anthropic",
    })
    await fake.hook("prompt")!({ sessionID: "ses_1" })
    expect(fake.activated).toEqual([])
  })
})
