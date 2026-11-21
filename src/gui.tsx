/** @jsxImportSource solid-js */
import { Plugin, Slot, createKeyed, usePlugin } from "@opencode/plugin/gui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import type { AccountUsage } from "./accounts"
import { REFRESH_MS, REQUEST_TIMEOUT_MS, TICK_MS } from "./constants"
import { ringProgress } from "./rings"
import { GoUsage } from "./rpc"
import { describeRpcError, formatResetsIn, usageColor, type UsageWindows } from "./usage"

type ViewState =
  | { phase: "loading" }
  | { phase: "ok"; accounts: AccountUsage[] }
  | { phase: "error"; text: string }

const WINDOWS = [
  ["rolling", "row.rolling"],
  ["weekly", "row.weekly"],
  ["monthly", "row.monthly"],
] as const

/** Three concentric rings, each colored by its own usage percentage. */
const RINGS = [
  { key: "rolling", radius: 7 },
  { key: "weekly", radius: 4.8 },
  { key: "monthly", radius: 2.6 },
] as const

export default Plugin.define({
  i18n: {
    en: {
      "rings.loading": "Go usage: loading…",
      "rings.timedOut": "timed out",
      "rings.unavailable": "Go usage: {{text}}",
      "rings.noUsage": "Go usage unavailable",
      "rings.tooltip": "{{label}} — rolling {{rolling}}% · weekly {{weekly}}% · monthly {{monthly}}%",
      "dialog.title": "OpenCode Go usage",
      "dialog.close": "Close",
      "dialog.active": "Active",
      "dialog.empty": "No OpenCode Go credentials found",
      "dialog.noUsage": "Usage unavailable",
      "dialog.stale": "cached",
      "dialog.reset": "resets in {{time}}",
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
    // its timer and in-flight request, so changing location ends both. The click
    // handler reuses the current run's refresh with `fresh: true`.
    let refreshNow: ((fresh?: boolean) => Promise<void>) | undefined

    createKeyed(
      () => ctx.sessions.current()?.location,
      (location) => {
        const controller = new AbortController()

        const refresh = async (fresh = false) => {
          let timedOut = false
          const timeout = new AbortController()
          const timer = setTimeout(() => {
            timedOut = true
            timeout.abort()
          }, REQUEST_TIMEOUT_MS)

          try {
            // JSON-Schema RPC output types as `unknown`; the server contract fixes the shape.
            const result = await ctx.client.rpc(GoUsage).getAll(
              fresh ? { fresh: true } : {},
              {
                location,
                signal: AbortSignal.any([controller.signal, timeout.signal]),
              },
            )
            setState({ phase: "ok", accounts: (result as { accounts: AccountUsage[] }).accounts })
          } catch (error) {
            if (controller.signal.aborted) return
            if (timedOut) {
              setState({ phase: "error", text: ctx.t("rings.timedOut") })
              return
            }
            setState({ phase: "error", text: describeRpcError(error) })
          } finally {
            clearTimeout(timer)
          }
        }

        refreshNow = refresh
        void refresh()
        const timer = setInterval(() => void refresh(), REFRESH_MS)

        onCleanup(() => {
          refreshNow = undefined
          clearInterval(timer)
          controller.abort()
        })
      },
      {
        equals: (left, right) => left.directory === right.directory && left.workspaceID === right.workspaceID,
        otherwise: () => {
          refreshNow = undefined
          setState({ phase: "loading" })
        },
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
      // Refresh in the background; the dialog reads the same signals and fills in.
      void refreshNow?.(true)
      ctx.dialogs.open((dialog) => (
        <UsageDialog accounts={accounts} error={errorText} now={now} onClose={dialog.close} />
      ))
    }

    // The timeline title row. The app's own contributions use order 10
    // (Toggle session context) and 20 (Session details, Toggle review), so a
    // negative order puts the rings first, as requested.
    ctx.add(Slot, {
      at: "session.header",
      order: -10,
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
          const percent = () => props.usage()?.[ring.key].percent ?? 0
          const color = () => usageColor(percent())
          const progress = () => ringProgress(percent(), ring.radius)
          return (
            <>
              <circle
                cx="9"
                cy="9"
                r={ring.radius}
                fill="none"
                stroke={color()}
                stroke-opacity="0.18"
                stroke-width="2"
              />
              <circle
                cx="9"
                cy="9"
                r={ring.radius}
                fill="none"
                stroke={color()}
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
  const ctx = usePlugin()

  return (
    <ctx.ui.Tooltip value={<span>{props.summary()}</span>} placement="bottom">
      <button
        type="button"
        data-testid="usage-rings"
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
    </ctx.ui.Tooltip>
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
    <div
      data-testid="usage-dialog"
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "8px",
        width: "min(420px, calc(100vw - 32px))",
        "box-sizing": "border-box",
        padding: "16px",
        "border-radius": "12px",
        background: "var(--v2-background-bg-layer-01, var(--v2-background-bg-base, Canvas))",
        color: "var(--v2-text-text-base, CanvasText)",
        "box-shadow": "var(--v2-elevation-overlay, 0 10px 40px rgba(0, 0, 0, 0.25))",
      }}
    >
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
                    <span style={{ color: usageColor(window().percent), "font-weight": 600 }}>
                      {Math.round(window().percent)}%
                    </span>
                    <span style={{ opacity: 0.65 }}>
                      {" · "}
                      {ctx.t("dialog.reset", { time: formatResetsIn(window().resetsAt, props.now()) })}
                    </span>
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
