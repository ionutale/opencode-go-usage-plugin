import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createLogger, sanitize } from "./log"

describe("createLogger", () => {
  it("writes one timestamped line per message", () => {
    const writes: Array<{ path: string; text: string }> = []
    const logger = createLogger({
      path: "/tmp/go-failover.log",
      now: () => Date.parse("2026-11-19T12:00:00.000Z"),
      append: (path, text) => writes.push({ path, text }),
      echo: () => {},
    })
    logger("switched to Go 2")
    expect(writes).toEqual([{ path: "/tmp/go-failover.log", text: "2026-11-19T12:00:00.000Z [go-failover] switched to Go 2\n" }])
  })

  it("echoes the same line", () => {
    const echo = vi.fn()
    const logger = createLogger({ path: "/tmp/x.log", append: () => {}, echo })
    logger("waiting")
    expect(echo).toHaveBeenCalledWith("waiting")
  })

  it("never throws when the file cannot be written", () => {
    const logger = createLogger({
      path: "/root/denied/x.log",
      append: () => {
        throw new Error("EACCES")
      },
      echo: () => {},
    })
    expect(() => logger("still alive")).not.toThrow()
  })

  it("never throws when echoing fails", () => {
    const logger = createLogger({
      path: "/tmp/x.log",
      append: () => {},
      echo: () => {
        throw new Error("EPIPE")
      },
    })
    expect(() => logger("still alive")).not.toThrow()
  })

  it("creates missing parent directories for the default append", () => {
    const mkdir = vi.fn()
    const logger = createLogger({
      path: "/tmp/does-not-matter/go-failover.log",
      append: () => {},
      echo: () => {},
      mkdir,
    })
    logger("hello")
    expect(mkdir).toHaveBeenCalled()
  })
})


describe("sanitize", () => {
  it("strips line breaks and control characters", () => {
    expect(sanitize("a\nb\rc\u0007d")).toBe("a b c d")
  })
})
