import { describe, expect, it } from "vitest"
import { ringProgress } from "./rings"

describe("ringProgress", () => {
  it("fills proportionally", () => {
    const full = ringProgress(100, 10)
    expect(full.circumference).toBeCloseTo(2 * Math.PI * 10)
    expect(ringProgress(50, 10).filled).toBeCloseTo(full.circumference / 2)
    expect(ringProgress(0, 10).filled).toBe(0)
  })

  it("clamps out-of-range values", () => {
    const full = ringProgress(100, 10).circumference
    expect(ringProgress(-5, 10).filled).toBe(0)
    expect(ringProgress(140, 10).filled).toBeCloseTo(full)
  })

  it("draws nothing for a non-finite percent", () => {
    expect(ringProgress(Number.NaN, 10).filled).toBe(0)
    expect(ringProgress(Number.POSITIVE_INFINITY, 10).filled).toBe(0)
  })

  it("scales with the radius", () => {
    expect(ringProgress(100, 5).filled).toBeCloseTo(2 * Math.PI * 5)
  })
})
