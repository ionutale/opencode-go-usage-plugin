# Use every short-window point and recover after a block

**Status**: accepted

Monthly quota is the only quota that expires at renewal; weekly and rolling
windows reset within the month. We use each subscription until any window
reaches 100%, then rotate reactively, rather than leaving a short-window buffer.
This maximizes quota use and keeps the monthly deadline first, at the cost that
a weekly or rolling limit can error the current turn and trigger a retry.

## Consequences

- `minHeadroom` defaults to 0; setting it above 0 opts into preventive bridging.
- The reactive path must rotate on a short-window block and retry.
- The last points before a weekly or rolling block are spent even when the reset
  is far away.
