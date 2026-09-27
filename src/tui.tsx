/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { Show, createSignal } from "solid-js"
import { GoUsage } from "./rpc"
import {
  barSegments,
  describeRpcError,
  formatResetsIn,
  usageColor,
  type UsageResult,
  type UsageWindow,
} from "./usage"

const REFRESH_MS = 30_000
const TICK_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

type ViewState =
  | { phase: "loading" }
  | { phase: "ok"; result: UsageResult }
  | { phase: "error"; text: string }

export default Plugin.define({
  id: "opencode-go-usage.tui",
  setup(context) {
    const rpc = context.client.rpc(GoUsage)
    const [state, setState] = createSignal<ViewState>({ phase: "loading" })
    const [now, setNow] = createSignal(Date.now())

    const refresh = async () => {
      try {
        // JSON-Schema RPC output types as `unknown`; the server contract fixes the shape.
        const location = context.location ?? context.data.location.default()
        const result = await rpc.get({}, { location, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        setState({ phase: "ok", result: result as UsageResult })
      } catch (error) {
        setState({ phase: "error", text: describeRpcError(error) })
      }
    }

    void refresh()
    const refreshTimer = setInterval(() => void refresh(), REFRESH_MS)
    const tickTimer = setInterval(() => setNow(Date.now()), TICK_MS)

    context.ui.slot({
      append: "sidebar.footer",
      render: () => <UsageBlock state={state} now={now} />,
    })

    return () => {
      clearInterval(refreshTimer)
      clearInterval(tickTimer)
    }
  },
})

function UsageBlock(props: { state: () => ViewState; now: () => number }) {
  const context = usePlugin()
  const muted = () => context.theme.text.muted
  const errorState = () => {
    const state = props.state()
    return state.phase === "error" ? state : undefined
  }
  const okState = () => {
    const state = props.state()
    return state.phase === "ok" ? state : undefined
  }

  return (
    <>
      <Show when={props.state().phase === "loading"}>
        <text fg={muted()}>Go usage: loading…</text>
      </Show>
      <Show when={errorState()}>
        {(state) => <text fg={muted()}>Go usage: {state().text}</text>}
      </Show>
      <Show when={okState()}>
        {(state) => {
          const stale = () => state().result.stale === true
          return (
            <box flexDirection="column">
              <UsageRow label="Rolling" window={() => state().result.usage.rolling} now={props.now} dim={stale} />
              <UsageRow label="Weekly" window={() => state().result.usage.weekly} now={props.now} dim={stale} />
              <UsageRow label="Monthly" window={() => state().result.usage.monthly} now={props.now} dim={stale} />
            </box>
          )
        }}
      </Show>
    </>
  )
}

function UsageRow(props: { label: string; window: () => UsageWindow; now: () => number; dim: () => boolean }) {
  const context = usePlugin()
  const accent = () => (props.dim() ? context.theme.text.muted : usageColor(props.window().percent))
  const percent = () => String(Math.round(props.window().percent)).padStart(3)
  return (
    <box flexDirection="row">
      <text fg={context.theme.text.muted}>{props.label.padEnd(9)}</text>
      <text fg={accent()}>{barSegments(props.window().percent)}</text>
      <text fg={accent()}>{`  ${percent()}%`}</text>
      <text fg={context.theme.text.muted}>{`  ${formatResetsIn(props.window().resetsAt, props.now())}`}</text>
    </box>
  )
}
