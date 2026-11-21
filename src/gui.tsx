/** @jsxImportSource solid-js */
import { Plugin, Slot, createKeyed, usePlugin } from "@opencode/plugin/gui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import type { AccountUsage } from "./accounts"
import { ringProgress } from "./rings"
import { GoUsage } from "./rpc"
import { describeRpcError, formatResetsIn, type UsageWindows } from "./usage"

const REFRESH_MS = 30_000
const TICK_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

type ViewState =
  | { phase: "loading" }
  | { phase: "ok"; accounts: AccountUsage[] }
  | { phase: "error"; text: string }

const WINDOWS = [
  ["rolling", "row.rolling"],
  ["weekly", "row.weekly"],
  ["monthly", "row.monthly"],
] as const

/** One identity color per window, like the three activity rings. */
const RINGS = [
  { key: "rolling", color: "#ff375f", radius: 7 },
  { key: "weekly", color: "#30d158", radius: 4.8 },
  { key: "monthly", color: "#0a84ff", radius: 2.6 },
] as const

const EMPTY_USAGE: UsageWindows = {
  rolling: { status: "unknown", percent: 0, resetsAt: "" },
  weekly: { status: "unknown", percent: 0, resetsAt: "" },
  monthly: { status: "unknown", percent: 0, resetsAt: "" },
}

export default Plugin.define({
  i18n: {
    en: {
      "rings.loading": "Go usage: loading…",
      "rings.unavailable": "Go usage: {{text}}",
      "rings.noUsage": "Go usage unavailable",
      "rings.tooltip": "{{label}} — rolling {{rolling}}% · weekly {{weekly}}% · monthly {{monthly}}%",
      "dialog.title": "OpenCode Go usage",
      "dialog.close": "Close",
      "dialog.active": "Active",
      "dialog.empty": "No OpenCode Go credentials found",
      "dialog.noUsage": "Usage unavailable",
      "dialog.stale": "cached",
      "dialog.row": "{{percent}}% · resets in {{time}}",
      "row.rolling": "Rolling",
      "row.weekly": "Weekly",
      "row.monthly": "Monthly",
    },
  },
  setup(ctx) {
    const [state, setState] = createSignal<ViewState>({ phase: "loading" })
    const [now, setNow] = createSignal(Date.now())

    // Countdowns in the dialog are recomputed from `now`, so tick it even when
    // the usage itself is unchanged.
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    onCleanup(() => clearInterval(tick))

    // Poll only while a session is routed, scoped to its location. Each run owns
    // its timer and in-flight request, so changing location ends both.
    createKeyed(
      () => ctx.sessions.current()?.location,
      (location) => {
        const controller = new AbortController()

        const refresh = async () => {
          try {
            // JSON-Schema RPC output types as `unknown`; the server contract fixes the shape.
            const result = await ctx.client.rpc(GoUsage).getAll(
              {},
              {
                location,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
              },
            )
            setState({ phase: "ok", accounts: (result as { accounts: AccountUsage[] }).accounts })
          } catch (error) {
            if (controller.signal.aborted) return
            setState({ phase: "error", text: describeRpcError(error) })
          }
        }

        void refresh()
        const timer = setInterval(() => void refresh(), REFRESH_MS)

        onCleanup(() => {
          clearInterval(timer)
          controller.abort()
        })
      },
      {
        equals: (left, right) => left.directory === right.directory && left.workspaceID === right.workspaceID,
      },
    )

    const accounts = () => {
      const current = state()
      return current.phase === "ok" ? current.accounts : []
    }

    const errorText = () => {
      const current = state()
      return current.phase === "error" ? current.text : undefined
    }

    const activeAccount = () => {
      const list = accounts()
      return list.find((account) => account.active && account.usage) ?? list.find((account) => account.usage)
    }

    const summary = () => {
      const current = state()
      if (current.phase === "loading") return ctx.t("rings.loading")
      if (current.phase === "error") return ctx.t("rings.unavailable", { text: current.text })
      const account = activeAccount()
      if (!account?.usage) return ctx.t("rings.noUsage")
      return ctx.t("rings.tooltip", {
        label: account.label,
        rolling: Math.round(account.usage.rolling.percent),
        weekly: Math.round(account.usage.weekly.percent),
        monthly: Math.round(account.usage.monthly.percent),
      })
    }

    const openUsage = () => {
      ctx.dialogs.open((dialog) => (
        <UsageDialog accounts={accounts} error={errorText} now={now} onClose={dialog.close} />
      ))
    }

    // The timeline title row, beside "Toggle session context", "Session details",
    // and "Toggle Review".
    ctx.add(Slot, {
      at: "session.header",
      order: 20,
      render: () => (
        <UsageButton
          usage={() => activeAccount()?.usage}
          summary={summary}
          onOpen={openUsage}
        />
      ),
    })
  },
})

function UsageRings(props: { usage: () => UsageWindows | undefined; dim?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      aria-hidden="true"
      style={{ opacity: props.dim ? 0.45 : 1, display: "block" }}
    >
      <For each={RINGS}>
        {(ring) => {
          const progress = () => ringProgress(props.usage()?.[ring.key].percent ?? 0, ring.radius)
          return (
            <>
              <circle
                cx="9"
                cy="9"
                r={ring.radius}
                fill="none"
                stroke={ring.color}
                stroke-opacity="0.18"
                stroke-width="2"
              />
              <circle
                cx="9"
                cy="9"
                r={ring.radius}
                fill="none"
                stroke={ring.color}
                stroke-width="2"
                stroke-linecap="round"
                stroke-dasharray={`${progress().filled} ${progress().circumference - progress().filled}`}
                transform="rotate(-90 9 9)"
              />
            </>
          )
        }}
      </For>
    </svg>
  )
}

function UsageButton(props: { usage: () => UsageWindows | undefined; summary: () => string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      title={props.summary()}
      aria-label={props.summary()}
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        width: "26px",
        height: "26px",
        padding: "0",
        border: "none",
        "border-radius": "6px",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
      }}
    >
      <UsageRings usage={props.usage} dim={props.usage() === undefined} />
    </button>
  )
}

function UsageDialog(props: {
  accounts: () => AccountUsage[]
  error: () => string | undefined
  now: () => number
  onClose: () => void
}) {
  const ctx = usePlugin()

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px", width: "360px" }}>
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "12px" }}>
        <span style={{ "font-weight": 600, "font-size": "13px" }}>{ctx.t("dialog.title")}</span>
        <button
          type="button"
          onClick={props.onClose}
          aria-label={ctx.t("dialog.close")}
          style={{
            border: "none",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            "font-size": "16px",
            "line-height": 1,
            padding: "0 2px",
          }}
        >
          ×
        </button>
      </div>

      <Show when={props.error()}>
        {(text) => <span style={{ "font-size": "12px", opacity: 0.7 }}>{ctx.t("rings.unavailable", { text: text() })}</span>}
      </Show>

      <Show
        when={props.accounts().length > 0}
        fallback={<span style={{ "font-size": "12px", opacity: 0.7 }}>{ctx.t("dialog.empty")}</span>}
      >
        <div style={{ display: "flex", "flex-direction": "column" }}>
          <For each={props.accounts()}>
            {(account) => <AccountCard account={account} now={props.now} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

function AccountCard(props: { account: AccountUsage; now: () => number }) {
  const ctx = usePlugin()

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "4px",
        padding: "8px 0",
        "border-top": "1px solid rgba(127, 127, 127, 0.2)",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "12px" }}>
        <span style={{ "font-weight": 600, "font-size": "12px" }}>{props.account.label}</span>
        <Show when={props.account.active}>
          <span
            style={{
              "font-size": "10px",
              "text-transform": "uppercase",
              "letter-spacing": "0.04em",
              padding: "1px 6px",
              "border-radius": "999px",
              background: "rgba(48, 209, 88, 0.16)",
              color: "#30d158",
            }}
          >
            {ctx.t("dialog.active")}
          </span>
        </Show>
      </div>

      <Show
        when={props.account.usage}
        fallback={
          <span style={{ "font-size": "12px", opacity: 0.65 }}>
            {props.account.error ?? ctx.t("dialog.noUsage")}
          </span>
        }
      >
        {(usage) => (
          <For each={WINDOWS}>
            {([key, labelKey]) => {
              const window = () => usage()[key]
              return (
                <div
                  style={{
                    display: "flex",
                    "align-items": "baseline",
                    "justify-content": "space-between",
                    gap: "12px",
                    "font-size": "12px",
                  }}
                >
                  <span style={{ opacity: 0.65 }}>{ctx.t(labelKey)}</span>
                  <span>
                    {ctx.t("dialog.row", {
                      percent: Math.round(window().percent),
                      time: formatResetsIn(window().resetsAt, props.now()),
                    })}
                  </span>
                </div>
              )
            }}
          </For>
        )}
      </Show>

      <Show when={props.account.stale}>
        <span style={{ "font-size": "11px", opacity: 0.55 }}>{ctx.t("dialog.stale")}</span>
      </Show>
    </div>
  )
}
