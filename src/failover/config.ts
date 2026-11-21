import { homedir } from "node:os"

export type Config = {
  provider: string
  credentialOrder: string[]
  proactiveThreshold: number
  hysteresisPoints: number
  usageCacheMs: number
  waitBufferMs: number
  notify: boolean
  maxWaitMs: number
  usageEndpoint: string
  logFile: string
}

export const DEFAULTS: Config = {
  provider: "opencode-go",
  credentialOrder: [],
  proactiveThreshold: 90,
  hysteresisPoints: 10,
  usageCacheMs: 10_000,
  waitBufferMs: 5_000,
  notify: false,
  maxWaitMs: Infinity,
  usageEndpoint: "https://opencode.ai/zen/go/v1/usage",
  logFile: `${homedir()}/.local/share/opencode/go-failover.log`,
}

export function readConfig(options: Record<string, unknown> | undefined): Config {
  const source = options ?? {}
  return {
    provider: nonEmptyString(source.provider) ?? DEFAULTS.provider,
    credentialOrder: stringArray(source.credentialOrder),
    proactiveThreshold: nonNegative(source.proactiveThreshold, DEFAULTS.proactiveThreshold),
    hysteresisPoints: nonNegative(source.hysteresisPoints, DEFAULTS.hysteresisPoints),
    usageCacheMs: nonNegative(source.usageCacheMs, DEFAULTS.usageCacheMs),
    waitBufferMs: nonNegative(source.waitBufferMs, DEFAULTS.waitBufferMs),
    notify: typeof source.notify === "boolean" ? source.notify : DEFAULTS.notify,
    maxWaitMs: waitLimit(source.maxWaitMs),
    usageEndpoint: nonEmptyString(source.usageEndpoint) ?? DEFAULTS.usageEndpoint,
    logFile: nonEmptyString(source.logFile) ?? DEFAULTS.logFile,
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function waitLimit(value: unknown): number {
  if (value === Infinity) return Infinity
  return nonNegative(value, DEFAULTS.maxWaitMs)
}
