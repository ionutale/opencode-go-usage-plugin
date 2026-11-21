import { Plugin } from "@opencode/plugin"
import { createAccountStore, type AccountContext } from "./accounts"
import { readConfig } from "./config"
import { chooseCandidate, classifyLimitError, evaluate, soonestReset, waitDelay, type Evaluated } from "./policy"
import { createLogger } from "./log"
import { createUsageClient } from "./usage"



type RetryEvent = {
  sessionID: string
  error: { type: string; message: string; status?: number; retryAfterMs?: number }
  decision: { retry: boolean; delay?: number }
}

let chain: Promise<unknown> = Promise.resolve()

/** Run decisions one at a time so concurrent sessions cannot rotate twice. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Compact countdown for the log, e.g. "renews in 12d 6h". */
function formatRenewal(at: number | undefined): string {
  if (at === undefined) return "renewal unknown"
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000))
  if (minutes >= 1440) return `renews in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
  if (minutes >= 60) return `renews in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `renews in ${minutes}m`
}

function fullest(evaluated: Evaluated): number {
  if (!evaluated.usage) return 0
  const { rolling, weekly, monthly } = evaluated.usage
  return Math.max(rolling.percent, weekly.percent, monthly.percent)
}

function byPreference(accounts: readonly Evaluated[], order: readonly string[]): Evaluated[] {
  const index = (account: Evaluated) => {
    const found = order.findIndex((entry) => entry === account.credentialID || entry === account.label)
    return found === -1 ? Number.MAX_SAFE_INTEGER : found
  }
  return [...accounts].sort((left, right) => index(left) - index(right))
}

export const failover = Plugin.define({
  id: "opencode-go-failover",
  async setup(ctx) {
    const config = readConfig(ctx.options)
    const store = createAccountStore(ctx as unknown as AccountContext, config.provider)
    const usage = createUsageClient({ cacheMs: config.usageCacheMs, endpoint: config.usageEndpoint })
    const tried = new Map<string, Set<string>>()

    const log = createLogger({ path: config.logFile })

    const snapshot = async (fresh = false): Promise<Evaluated[]> => {
      const accounts = await store.list()
      return Promise.all(
        accounts.map(async (account) => {
          try {
            const key = await store.key(account)
            if (!key) return evaluate(account, undefined)
            return evaluate(account, await usage.read({ credentialID: account.credentialID, key }, { fresh }))
          } catch (error) {
            log(`${account.label}: usage unavailable (${describe(error)})`)
            return evaluate(account, undefined)
          }
        }),
      )
    }

    const notify = async (sessionID: string, text: string) => {
      if (!config.notify) return
      try {
        await ctx.session.synthetic({ sessionID, text })
      } catch (error) {
        log(`notification failed: ${describe(error)}`)
      }
    }

    const activate = async (account: Evaluated, reason: string) => {
      await store.activate(account.credentialID)
      log(`${reason}: ${account.label} (${account.headroom} points of headroom, ${formatRenewal(account.renewalAt)})`)
    }

    const proactive = async () => {
      if (config.proactiveThreshold <= 0) return
      const activeID = await store.activeID()
      const accounts = await snapshot(false)
      if (accounts.length < 2) return

      const active = accounts.find((account) => account.credentialID === activeID)
      if (!active || active.state === "unknown") return
      if (active.state === "available" && fullest(active) < config.proactiveThreshold) return

      const candidate = chooseCandidate({
        accounts,
        activeID,
        order: config.credentialOrder,
        hysteresisPoints: config.hysteresisPoints,
      })
      if (!candidate) return

      await activate(candidate, `switched ahead of the limit (${fullest(active)}% -> ${fullest(candidate)}%)`)
    }

    await ctx.session.hook("prompt", (event) =>
      serial(async () => {
        try {
          const sessionID = (event as { sessionID?: string }).sessionID
          if (!sessionID) return
          // The prompt hook cannot be provider-scoped, so gate on the session's
          // model: a prompt for another provider must not read Go usage or move
          // the global Go credential.
          const session = await ctx.session.get({ sessionID })
          if (session?.model && session.model.providerID !== config.provider) return
          tried.delete(sessionID)
          await proactive()
        } catch (error) {
          log(`proactive check failed: ${describe(error)}`)
        }
      }),
    )

    await ctx.session.hook(
      "retry",
      (event) =>
        serial(async () => {
          try {
            await reactive(event as RetryEvent)
          } catch (error) {
            log(`failover failed: ${describe(error)}`)
          }
        }),
      { providerID: config.provider },
    )

    async function reactive(event: RetryEvent) {
      if (!classifyLimitError(event.error)) return

      const activeID = await store.activeID()
      const accounts = await snapshot(true)

      // A bare 429 is usually a burst rate limit, not quota exhaustion. Rotating
      // on it makes the burst worse: each retry is another request, often on a
      // fresh key that is immediately limited too. Unless the host names a quota
      // type, rotate only when the active account's own usage agrees it is out.
      const activeNow = accounts.find((account) => account.credentialID === activeID)
      const typedQuota = /go-?limit|quota/i.test(event.error.type)
      if (
        event.error.status === 429 &&
        !typedQuota &&
        activeNow?.state === "available" &&
        fullest(activeNow) < config.proactiveThreshold
      ) {
        log(
          `429 at ${fullest(activeNow)}% looks like a rate limit, not quota; leaving the retry delay to OpenCode`,
        )
        return
      }

      const session = tried.get(event.sessionID) ?? new Set<string>()
      tried.set(event.sessionID, session)
      if (activeID) session.add(activeID)

      const untried = accounts.filter((account) => !session.has(account.credentialID))
      const candidate = chooseCandidate({
        accounts: untried,
        activeID,
        order: config.credentialOrder,
        hysteresisPoints: 0,
      })

      if (candidate) {
        session.add(candidate.credentialID)
        await activate(candidate, "rotated after a limit error")
        event.decision = { retry: true, delay: 0 }
        await notify(event.sessionID, `OpenCode Go switched to ${candidate.label} after hitting a usage limit.`)
        return
      }

      const measured = accounts.some((account) => account.state !== "unknown")
      if (!measured) {
        const next = byPreference(untried, config.credentialOrder)[0]
        if (next) {
          session.add(next.credentialID)
          await activate(next, "rotated without usage data")
          event.decision = { retry: true, delay: 0 }
          return
        }
        // Every account has been tried and nothing can be measured: stop rotating
        // and let OpenCode surface its own error instead of spinning.
        log("no usage data and every account was tried in this turn; leaving the error to surface")
        return
      }

      // All accounts were tried this turn. Waiting only helps when a blocking
      // window actually resets; if usage still claims an account is available,
      // that account already failed the provider, so surface the error instead
      // of flipping credentials every few seconds.
      const now = Date.now()
      const reset = soonestReset(accounts, now)
      if (reset === undefined || reset <= 0) {
        log("every account was tried and no window reset is pending; leaving the error to surface")
        return
      }

      const delay = waitDelay({
        accounts,
        nowMs: now,
        retryAfterMs: event.error.retryAfterMs,
        bufferMs: config.waitBufferMs,
        maxWaitMs: config.maxWaitMs,
      })
      session.clear()
      event.decision = { retry: true, delay }
      log(`all accounts blocked, waiting ${Math.round(delay / 1000)}s for the next window`)
      await notify(event.sessionID, `Every OpenCode Go account is out of quota; retrying in ${Math.round(delay / 1000)}s.`)
    }
  },
})
