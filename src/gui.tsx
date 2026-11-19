/** @jsxImportSource solid-js */
import { ComposerPill, Plugin, createKeyed, type ComposerPillView } from "@opencode/plugin/gui"
import { createSignal, onCleanup } from "solid-js"
import { GoUsage } from "./rpc"
import {
  describeRpcError,
  formatResetsIn,
  usageTone,
  type UsageResult,
  type UsageTone,
  type UsageWindow,
} from "./usage"

const REFRESH_MS = 30_000
const TICK_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

type ViewState =
  | { phase: "loading" }
  | { phase: "ok"; result: UsageResult }
  | { phase: "error"; text: string }

const WINDOWS = [
  ["rolling", "row.rolling"],
  ["weekly", "row.weekly"],
  ["monthly", "row.monthly"],
] as const

/** Rows color only their icon, so each tone gets the matching status glyph. */
const TONE_ICON: Record<UsageTone, "circle-check" | "circle-exclamation" | "circle-x"> = {
  success: "circle-check",
  warning: "circle-exclamation",
  danger: "circle-x",
}

export default Plugin.define({
  i18n: {
    en: {
      title: "OpenCode Go usage",
      "title.cached": "OpenCode Go usage (cached)",
      pill: "Go {{percent}}%",
      unavailable: "Go usage: {{text}}",
      "row.rolling": "Rolling",
      "row.weekly": "Weekly",
      "row.monthly": "Monthly",
      "row.detail": "{{percent}}% · resets in {{resetsIn}}",
    },
  },
  setup(ctx) {
    const [state, setState] = createSignal<ViewState>({ phase: "loading" })
    const [now, setNow] = createSignal(Date.now())

    // The countdown in each row is recomputed from `now`, so tick it even when the
    // usage itself is unchanged.
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    onCleanup(() => clearInterval(tick))

    // Poll only while a session is routed, scoped to its location. Each run owns its
    // timer and in-flight request, so changing location ends both.
    createKeyed(
      () => ctx.sessions.current()?.location,
      (location) => {
        const controller = new AbortController()

        const refresh = async () => {
          try {
            // JSON-Schema RPC output types as `unknown`; the server contract fixes the shape.
            const result = await ctx.client.rpc(GoUsage).get(
              {},
              {
                location,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
              },
            )
            setState({ phase: "ok", result: result as UsageResult })
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

    const usageRow = (id: string, labelKey: string, window: UsageWindow) => {
      const tone = usageTone(window.percent)
      return {
        id,
        label: ctx.t(labelKey),
        icon: TONE_ICON[tone],
        tone,
        detail: ctx.t("row.detail", {
          percent: Math.round(window.percent),
          resetsIn: formatResetsIn(window.resetsAt, now()),
        }),
      }
    }

    ctx.add(ComposerPill, {
      id: "usage",
      order: 10,
      show(): ComposerPillView | undefined {
        const current = state()

        // Nothing is known yet: stay out of the composer's way.
        if (current.phase === "loading") return undefined

        if (current.phase === "error") {
          return {
            icon: "status",
            tone: "warning",
            label: ctx.t("unavailable", { text: current.text }),
            title: ctx.t("title"),
          }
        }

        const { usage, stale } = current.result
        const percent = Math.round(Math.max(...WINDOWS.map(([key]) => usage[key].percent)))

        return {
          icon: "status",
          tone: usageTone(percent),
          label: ctx.t("pill", { percent }),
          title: ctx.t(stale ? "title.cached" : "title"),
          rows: WINDOWS.map(([key, labelKey]) => usageRow(key, labelKey, usage[key])),
        }
      },
    })
  },
})
