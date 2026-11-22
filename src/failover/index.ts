import { Plugin } from "@opencode/plugin"
import { formatDuration } from "../usage"
import { createAccountStore, type AccountContext } from "./accounts"
import { readConfig } from "./config"
import {
  chooseCandidate,
  classifyLimitError,
  evaluate,
  orderIndex,
  soonestReset,
  waitDelay,
  type Evaluated,
} from "./policy"
import { createLogger, sanitize, type Logger } from "./log"
import { createUsageClient } from "./usage"

const PROVIDER = "opencode-go"
/** A bare 429 below this usage level is treated as a burst limit, not quota. */
const RATE_LIMIT_THRESHOLD = 90
const MAX_TRIED_SESSIONS = 100

type RetryEvent = {
  sessionID: string
  error: { type: string; message: string; status?: number; retryAfterMs?: number }
  decision: { retry: boolean; delay?: number }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>
    if (typeof record.message === "string") return record.message
    if (typeof record.type === "string") return record.type
  }
  return String(error)
}

/** Compact countdown for the log, e.g. "renews in 12d 6h". */
function formatRenewal(at: number | undefined): string {
  if (at === undefined) return "renewal unknown"
  return `renews in ${formatDuration(Math.max(0, at - Date.now()))}`
}

function fullest(evaluated: Evaluated): number {
  if (!evaluated.usage) return 0
  const { rolling, weekly, monthly } = evaluated.usage
  return Math.max(rolling.percent, weekly.percent, monthly.percent)
}

export function createFailover(injectedLog?: Logger) {
  return Plugin.define({
    id: "opencode-go-failover",
    async setup(ctx) {
      const config = readConfig(ctx.options)
      const log = injectedLog ?? createLogger()
      const store = createAccountStore(ctx as unknown as AccountContext, PROVIDER)
      const usage = createUsageClient({ cacheMs: config.usageCacheMs })
      const tried = new Map<string, Set<string>>()

      // Per instance, so two plugin instances (or tests) do not share a queue.
      let chain: Promise<unknown> = Promise.resolve()
      const serial = <T>(task: () => Promise<T>): Promise<T> => {
        const run = chain.then(task, task)
        chain = run.then(
          () => undefined,
          () => undefined,
        )
        return run
      }

      const sessionTried = (sessionID: string): Set<string> => {
        const existing = tried.get(sessionID) ?? new Set<string>()
        tried.set(sessionID, existing)
        if (tried.size > MAX_TRIED_SESSIONS) {
          const oldest = tried.keys().next().value
          if (oldest !== undefined) tried.delete(oldest)
        }
        return existing
      }

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

      const proactive = async (fresh = false) => {
        if (config.proactiveThreshold <= 0) return
        const activeID = await store.activeID()
        const accounts = await snapshot(fresh)
        if (accounts.length < 2) return

        const active = accounts.find((account) => account.credentialID === activeID)
        if (!active) return

        // Renewal-first queue: the active is included so that being the best
        // eligible account means no switch. An account leaves the queue once
        // its monthly renewal has passed, any window hits 100%, or its monthly
        // usage reaches the drain threshold. A temporary weekly/rolling block
        // only bridges.
        const ideal = chooseCandidate({
          accounts,
          activeID: undefined,
          order: config.credentialOrder,
          minHeadroom: config.minHeadroom,
          monthlyUnder: config.proactiveThreshold,
          nowMs: Date.now(),
        })
        if (!ideal || ideal.credentialID === activeID) return

        try {
          await activate(
            ideal,
            `switched to drain the soonest renewal (monthly ${Math.round(ideal.usage?.monthly.percent ?? 0)}%)`,
          )
        } catch (error) {
          log(`activation failed for ${ideal.label}: ${describe(error)}`)
        }
      }

      /** Tries candidates until one activates; a failed account is not retried this turn. */
      const rotate = async (
        pool: Evaluated[],
        activeID: string | undefined,
        session: Set<string>,
        reason: string,
      ): Promise<Evaluated | undefined> => {
        let remaining = pool
        for (;;) {
          const candidate = chooseCandidate({
            accounts: remaining,
            activeID,
            order: config.credentialOrder,
            minHeadroom: 0,
            nowMs: Date.now(),
          })
          if (!candidate) return undefined

          try {
            await activate(candidate, reason)
            session.add(candidate.credentialID)
            return candidate
          } catch (error) {
            session.add(candidate.credentialID)
            log(`activation failed for ${candidate.label}: ${describe(error)}`)
            remaining = remaining.filter((account) => account.credentialID !== candidate.credentialID)
          }
        }
      }

      await ctx.session.hook("prompt", (event) =>
        serial(async () => {
          try {
            const sessionID = (event as { sessionID?: string }).sessionID
            if (!sessionID) return
            // The prompt hook cannot be provider-scoped: skip when the model is
            // unknown or belongs to another provider.
            const session = await ctx.session.get({ sessionID })
            if (!session?.model || session.model.providerID !== PROVIDER) return
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
        { providerID: PROVIDER },
      )

      // Re-evaluate on the same cadence as the usage display. The timer is
      // unref'd so it never keeps the host process alive, and the plugin's
      // cleanup clears it on unload. Decisions share the serial queue, so a
      // periodic check cannot race a prompt or retry decision.
      const evaluateTimer =
        config.evaluateIntervalMs > 0 && config.proactiveThreshold > 0
          ? setInterval(() => {
              void serial(async () => {
                try {
                  await proactive(true)
                } catch (error) {
                  log(`periodic evaluation failed: ${describe(error)}`)
                }
              })
            }, config.evaluateIntervalMs)
          : undefined
      evaluateTimer?.unref?.()

      async function reactive(event: RetryEvent) {
        if (!classifyLimitError(event.error)) return

        const activeID = await store.activeID()
        const accounts = await snapshot(true)

        // A bare 429 is usually a burst rate limit, not quota exhaustion. Rotating
        // on it makes the burst worse. Unless the type or message names a quota,
        // rotate only when the active account's own usage agrees it is out.
        const activeNow = accounts.find((account) => account.credentialID === activeID)
        const typedQuota = /go-?limit|quota/i.test(`${event.error.type} ${event.error.message}`)
        if (
          event.error.status === 429 &&
          !typedQuota &&
          activeNow?.state === "available" &&
          fullest(activeNow) < RATE_LIMIT_THRESHOLD
        ) {
          log(`429 at ${fullest(activeNow)}% looks like a rate limit, not quota; leaving the retry delay to OpenCode`)
          return
        }

        const session = sessionTried(event.sessionID)
        if (activeID) session.add(activeID)

        const untried = accounts.filter((account) => !session.has(account.credentialID))
        const candidate = await rotate(untried, activeID, session, "rotated after a limit error")
        if (candidate) {
          event.decision = { retry: true, delay: 0 }
          await notify(event.sessionID, `OpenCode Go switched to ${sanitize(candidate.label)} after hitting a usage limit.`)
          return
        }

        const measured = accounts.some((account) => account.state !== "unknown")
        if (!measured) {
          let next: Evaluated | undefined
          for (const account of [...untried].sort(
            (left, right) => orderIndex(config.credentialOrder, left) - orderIndex(config.credentialOrder, right),
          )) {
            try {
              await activate(account, "rotated without usage data")
              session.add(account.credentialID)
              next = account
              break
            } catch (error) {
              session.add(account.credentialID)
              log(`activation failed for ${account.label}: ${describe(error)}`)
            }
          }
          if (next) {
            event.decision = { retry: true, delay: 0 }
            return
          }
          log("no usage data and every account was tried in this turn; leaving the error to surface")
          return
        }

        // All accounts were tried this turn. Waiting only helps when a blocking
        // window actually resets, or the host asked for a specific backoff.
        const now = Date.now()
        const reset = soonestReset(accounts, now)
        const retryAfterMs = event.error.retryAfterMs
        const hasRetryAfter =
          typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        if ((reset === undefined || reset <= 0) && !hasRetryAfter) {
          log("every account was tried and no window reset is pending; leaving the error to surface")
          return
        }

        const delay = waitDelay({
          accounts,
          nowMs: now,
          retryAfterMs,
          bufferMs: config.waitBufferMs,
          maxWaitMs: config.maxWaitMs,
        })
        session.clear()
        event.decision = { retry: true, delay }
        log(`all accounts blocked, waiting ${Math.round(delay / 1000)}s for the next window`)
        await notify(event.sessionID, `Every OpenCode Go account is out of quota; retrying in ${Math.round(delay / 1000)}s.`)
      }

      return () => {
        if (evaluateTimer) clearInterval(evaluateTimer)
      }
    },
  })
}

export const failover = createFailover()
