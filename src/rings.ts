/** Dash lengths for one activity-style ring at a given percentage. */
export type RingProgress = {
  circumference: number
  filled: number
}

/**
 * Clamps `percent` to 0..100 and turns it into the filled length of a ring.
 * Non-finite values draw nothing, matching `barSegments` and `usageColor`.
 */
export function ringProgress(percent: number, radius: number): RingProgress {
  const circumference = 2 * Math.PI * radius
  const bounded = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  return { circumference, filled: (bounded / 100) * circumference }
}
