# OpenCode Go quota and failover

This context covers the OpenCode Go subscriptions, their quota windows, and how
the plugin chooses the active credential.

## Language

**Subscription**:
One OpenCode Go credential with its own rolling, weekly, and monthly quotas.
_Avoid_: account, provider, key

**Monthly renewal**:
The next future monthly reset; the point at which that subscription's monthly
quota is replaced and the deadline for using it.
_Avoid_: expiration, monthly reset (when you mean the deadline)

**Weekly reset**:
The next weekly reset; the weekly quota is replaced. It is not a subscription
renewal.
_Avoid_: weekly renewal, weekly expiration

**Rolling reset**:
The next rolling reset; the short-term quota is replaced.
_Avoid_: rolling renewal

**Available**:
A subscription with usage data and no window at 100% or not `ok`; it can serve
until it is exhausted.
_Avoid_: eligible

**Exhausted**:
A quota window at 100% or not `ok`; the subscription cannot serve until that
window resets.
_Avoid_: expired, used up

**Expired**:
A subscription whose monthly renewal is in the past, or whose key is rejected
with 401/403. It is skipped for the cycle.
_Avoid_: exhausted, blocked

**Active credential**:
The single global Go key OpenCode uses for the next request.
_Avoid_: current subscription

**Eligible**:
An available subscription whose monthly renewal is in the future, whose monthly
usage is below the drain threshold, and whose headroom is at least the optional
floor.
_Avoid_: available

**Target**:
The first eligible subscription in the monthly → weekly → rolling →
`credentialOrder` → headroom order.

**Drain**:
Use the target until a quota window reaches 100%, then move to the next eligible
subscription.
_Avoid_: burn, spend down

**Bridge**:
Temporarily using a later-renewing eligible subscription while the target is
exhausted or under a configured floor.
