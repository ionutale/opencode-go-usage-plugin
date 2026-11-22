import { homedir } from "node:os"
import { join } from "node:path"

export type Config = {
  credentialOrder: string[]
  proactiveThreshold: number
  minHeadroom: number
  evaluateIntervalMs: number
  usageCacheMs: number
  waitBufferMs: number
  notify: boolean
  maxWaitMs: number
}

export const DEFAULT_LOG_FILE = join(homedir(), ".local/share/opencode/go-failover.log")

const EMPTY_ORDER: string[] = Object.freeze([]) as unknown as string[]

export const DEFAULTS: Config = Object.freeze({
  credentialOrder: EMPTY_ORDER,
  proactiveThreshold: 100,
  minHeadroom: 0,
  evaluateIntervalMs: 600_000,
  usageCacheMs: 10_000,
  waitBufferMs: 5_000,
  notify: false,
  maxWaitMs: 300_000,
})

export function readConfig(options: Record<string, unknown> | undefined): Config {
  const source = options ?? {}
  return {
    credentialOrder: stringArray(source.credentialOrder),
    proactiveThreshold: nonNegative(source.proactiveThreshold, DEFAULTS.proactiveThreshold),
    minHeadroom: nonNegative(source.minHeadroom, DEFAULTS.minHeadroom),
    evaluateIntervalMs: nonNegative(source.evaluateIntervalMs, DEFAULTS.evaluateIntervalMs),
    usageCacheMs: nonNegative(source.usageCacheMs, DEFAULTS.usageCacheMs),
    waitBufferMs: nonNegative(source.waitBufferMs, DEFAULTS.waitBufferMs),
    notify: typeof source.notify === "boolean" ? source.notify : DEFAULTS.notify,
    maxWaitMs: waitLimit(source.maxWaitMs),
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function waitLimit(value: unknown): number {
  return nonNegative(value, DEFAULTS.maxWaitMs)
}
