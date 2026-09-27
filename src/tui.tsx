import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { GoUsage } from "./rpc"
import {
  barSegments,
  describeRpcError,
  formatResetsIn,
  usageColor,
  type UsageResult,
  type UsageWindow,
} from "./usage"

const REFRESH_MS = 60_000
const TICK_MS = 30_000

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
        setState({ phase: "ok", result: (await rpc.get({})) as UsageResult })
      } catch (error) {
        setState({ phase: "error", text: describeRpcError(error) })
      }
    }

    void refresh()
    const refreshTimer = setInterval(() => void refresh(), REFRESH_MS)
    const tickTimer = setInterval(() => setNow(Date.now()), TICK_MS)

    context.ui.slot({
      append: "sidebar.footer",
      render: () => <UsageBlock state={state()} now={now()} />,
    })

    return () => {
      clearInterval(refreshTimer)
      clearInterval(tickTimer)
    }
  },
})

function UsageBlock(props: { state: ViewState; now: number }) {
  const context = usePlugin()
  const muted = () => context.theme.text.muted

  if (props.state.phase === "loading") {
    return <text fg={muted()}>Go usage: loading…</text>
  }
  if (props.state.phase === "error") {
    return <text fg={muted()}>Go usage: {props.state.text}</text>
  }

  const stale = props.state.result.stale === true
  return (
    <box flexDirection="column">
      <UsageRow label="Rolling" window={props.state.result.usage.rolling} now={props.now} dim={stale} />
      <UsageRow label="Weekly" window={props.state.result.usage.weekly} now={props.now} dim={stale} />
      <UsageRow label="Monthly" window={props.state.result.usage.monthly} now={props.now} dim={stale} />
    </box>
  )
}

function UsageRow(props: { label: string; window: UsageWindow; now: number; dim: boolean }) {
  const context = usePlugin()
  const accent = () => (props.dim ? context.theme.text.muted : usageColor(props.window.percent))
  const percent = () => String(Math.round(props.window.percent)).padStart(3)
  return (
    <box flexDirection="row">
      <text fg={context.theme.text.muted}>{props.label.padEnd(9)}</text>
      <text fg={accent()}>{barSegments(props.window.percent)}</text>
      <text fg={accent()}>{`  ${percent()}%`}</text>
      <text fg={context.theme.text.muted}>{`  ${formatResetsIn(props.window.resetsAt, props.now)}`}</text>
    </box>
  )
}
