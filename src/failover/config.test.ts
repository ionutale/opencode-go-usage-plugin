import { describe, expect, it } from "vitest"
import { DEFAULTS, readConfig } from "./config"

const DOCUMENTED_DEFAULTS = {
  credentialOrder: [],
  proactiveThreshold: 90,
  minHeadroom: 10,
  evaluateIntervalMs: 600_000,
  usageCacheMs: 10_000,
  waitBufferMs: 5_000,
  notify: false,
  maxWaitMs: 300_000,
}

describe("readConfig", () => {
  it("returns the documented defaults for undefined options", () => {
    expect(readConfig(undefined)).toEqual(DOCUMENTED_DEFAULTS)
  })

  it("keeps valid overrides", () => {
    const config = readConfig({
      proactiveThreshold: 75,
      minHeadroom: 5,
      evaluateIntervalMs: 30_000,
      notify: true,
      maxWaitMs: 60_000,
    })
    expect(config.proactiveThreshold).toBe(75)
    expect(config.minHeadroom).toBe(5)
    expect(config.evaluateIntervalMs).toBe(30_000)
    expect(config.notify).toBe(true)
    expect(config.maxWaitMs).toBe(60_000)
  })

  it("falls back for wrong types instead of throwing", () => {
    const config = readConfig({
      proactiveThreshold: "90",
      minHeadroom: -1,
      evaluateIntervalMs: -1,
      usageCacheMs: -1,
      notify: "yes",
      credentialOrder: "Work",
    })
    expect(config.proactiveThreshold).toBe(90)
    expect(config.minHeadroom).toBe(10)
    expect(config.evaluateIntervalMs).toBe(600_000)
    expect(config.usageCacheMs).toBe(10_000)
    expect(config.notify).toBe(false)
    expect(config.credentialOrder).toEqual([])
  })

  it("accepts an explicit credential order", () => {
    expect(readConfig({ credentialOrder: ["Work", "Personal"] }).credentialOrder).toEqual(["Work", "Personal"])
  })

  it("rejects an infinite or negative wait", () => {
    expect(readConfig({ maxWaitMs: Infinity }).maxWaitMs).toBe(300_000)
    expect(readConfig({ maxWaitMs: -1 }).maxWaitMs).toBe(300_000)
    expect(readConfig({ maxWaitMs: Number.NaN }).maxWaitMs).toBe(300_000)
  })

  it("keeps the defaults frozen", () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
    expect(Object.isFrozen(DEFAULTS.credentialOrder)).toBe(true)
  })
})
