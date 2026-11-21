import { describe, expect, it } from "vitest"
import { DEFAULTS, readConfig } from "./config"

describe("readConfig", () => {
  it("returns the documented defaults for undefined options", () => {
    expect(readConfig(undefined)).toEqual(DEFAULTS)
  })

  it("keeps valid overrides", () => {
    const config = readConfig({ proactiveThreshold: 75, hysteresisPoints: 5, notify: true, maxWaitMs: 60_000 })
    expect(config.proactiveThreshold).toBe(75)
    expect(config.hysteresisPoints).toBe(5)
    expect(config.notify).toBe(true)
    expect(config.maxWaitMs).toBe(60_000)
  })

  it("falls back for wrong types instead of throwing", () => {
    const config = readConfig({ proactiveThreshold: "90", usageCacheMs: -1, notify: "yes", credentialOrder: "Work" })
    expect(config.proactiveThreshold).toBe(90)
    expect(config.usageCacheMs).toBe(10_000)
    expect(config.notify).toBe(false)
    expect(config.credentialOrder).toEqual([])
  })

  it("accepts an explicit credential order and provider", () => {
    expect(readConfig({ credentialOrder: ["Work", "Personal"], provider: "acme" }).credentialOrder).toEqual([
      "Work",
      "Personal",
    ])
    expect(readConfig({ provider: "acme" }).provider).toBe("acme")
  })

  it("accepts a usage endpoint override", () => {
    expect(readConfig({ usageEndpoint: "http://127.0.0.1:9999/usage" }).usageEndpoint).toBe("http://127.0.0.1:9999/usage")
    expect(readConfig(undefined).usageEndpoint).toBe("https://opencode.ai/zen/go/v1/usage")
  })

  it("accepts a log file override and defaults to the shared log directory", () => {
    expect(readConfig({ logFile: "/tmp/go.log" }).logFile).toBe("/tmp/go.log")
    expect(readConfig(undefined).logFile).toMatch(/go-failover\.log$/)
  })
})
