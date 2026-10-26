/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { GoUsage } from "./rpc"
import {
  aggregateModels,
  describeRange,
  filterRows,
  formatCost,
  formatTokens,
  modelOptions,
  providerOptions,
  rangeWindow,
  sortRows,
  sumRows,
  type RangeKey,
  type RangeWindow,
  type SortDirection,
  type SortKey,
  type StatsResponse,
  type TokenRow,
  type TokenTotals,
} from "./tokens"
import {
  RED,
  YELLOW,
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
const QUOTA_TIMEOUT_MS = 5_000
const STATS_TIMEOUT_MS = 30_000
const DEFAULT_PROVIDER = "opencode-go"

const RANGE_OPTIONS: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: "rolling", label: "1 Rolling" },
  { key: "week", label: "2 Week" },
  { key: "month", label: "3 Month" },
  { key: "all", label: "4 All" },
]

const SORT_KEYS: readonly SortKey[] = [
  "total",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "steps",
  "cost",
  "reasoning",
]

const SORT_LABELS: Record<SortKey, string> = {
  total: "Total",
  input: "Input",
  output: "Output",
  reasoning: "Reasoning",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  steps: "Steps",
  cost: "Cost",
}

type Filters = {
  range: RangeKey
  provider: string
  model: string
  sort: SortKey
  direction: SortDirection
  cost: boolean
  exact: boolean
}

const DEFAULT_FILTERS: Filters = {
  range: "month",
  provider: DEFAULT_PROVIDER,
  model: "all",
  sort: "total",
  direction: "desc",
  cost: false,
  exact: false,
}

// TUI-session memory: reopening /tokens keeps the last view, a fresh TUI resets it.
let rememberedFilters: Filters = { ...DEFAULT_FILTERS }

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

    const openTokens = () => {
      context.ui.dialog.clear()
      context.ui.dialog.show(() => <TokensDialog />)
      // `show` replaces the dialog and resets its presentation to medium; set
      // the requested xlarge, centered presentation after the replace.
      context.ui.dialog.set({ size: "xlarge", centered: true })
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode-go-usage.tokens",
          title: "Go usage: tokens by model",
          group: "Go usage",
          palette: true,
          slash: { name: "tokens" },
          run: openTokens,
        },
      ],
    }))

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

/**
 * The /tokens modal. It intentionally lives in this file: the package's
 * build script transforms only src/tui.tsx, so JSX in a sibling file would
 * not compile for packaged installs.
 */
function TokensDialog() {
  const context = usePlugin()
  const dimensions = useTerminalDimensions()
  const rpc = context.client.rpc(GoUsage)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

  const [filters, setFilters] = createSignal<Filters>({ ...rememberedFilters })
  const [usage, setUsage] = createSignal<UsageResult | undefined>()
  const [usageError, setUsageError] = createSignal<string | undefined>()
  const [stats, setStats] = createSignal<StatsResponse | undefined>()
  const [statsError, setStatsError] = createSignal<string | undefined>()
  const [loading, setLoading] = createSignal(true)
  const [updatedAt, setUpdatedAt] = createSignal<number | undefined>()
  const [queryNow, setQueryNow] = createSignal(Date.now())
  const [now, setNow] = createSignal(Date.now())

  let requestID = 0
  let disposed = false
  let tickTimer: ReturnType<typeof setInterval> | undefined

  const update = (patch: Partial<Filters>) => {
    const next = { ...filters(), ...patch }
    setFilters(next)
    rememberedFilters = next
  }

  const loadQuota = async () => {
    try {
      const location = context.location ?? context.data.location.default()
      const result = await rpc.get({}, { location, signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS) })
      if (disposed) return
      setUsage(result as UsageResult)
      setUsageError(undefined)
    } catch (error) {
      if (disposed) return
      setUsage(undefined)
      setUsageError(describeRpcError(error))
    }
  }

  const loadStats = async () => {
    if (disposed) return
    const id = ++requestID
    const at = Date.now()
    setQueryNow(at)
    setLoading(true)
    setStatsError(undefined)
    setStats(undefined)
    setUpdatedAt(undefined)

    const activeWindow = rangeWindow(filters().range, usage(), at)
    try {
      const result = await context.client.session.stats(
        {
          from: activeWindow.from,
          to: activeWindow.to,
          timezone,
          tools: "none",
        },
        { signal: AbortSignal.timeout(STATS_TIMEOUT_MS) },
      )
      if (disposed || id !== requestID) return
      setStats(result as StatsResponse)
      setUpdatedAt(Date.now())
    } catch (error) {
      if (disposed || id !== requestID) return
      setStatsError(describeError(error))
    } finally {
      if (!disposed && id === requestID) setLoading(false)
    }
  }

  const load = async () => {
    await loadQuota()
    if (disposed) return
    await loadStats()
  }

  const selectRange = (range: RangeKey) => {
    if (filters().range === range) return
    update({ range })
    void loadStats()
  }

  const allRows = createMemo(() => aggregateModels(stats()?.models ?? []))
  const rows = createMemo(() =>
    sortRows(filterRows(allRows(), filters().provider, filters().model), filters().sort, filters().direction),
  )
  const totals = createMemo(() => sumRows(rows()))
  const activeWindow = createMemo(() => rangeWindow(filters().range, usage(), queryNow()))

  const providers = createMemo(() => {
    const list = providerOptions(allRows())
    return filters().provider !== "all" && !list.includes(filters().provider)
      ? [filters().provider, ...list]
      : list
  })
  const providerChoices = createMemo(() => ["all", ...providers()])
  const models = createMemo(() => {
    const list = modelOptions(allRows(), filters().provider)
    return filters().model !== "all" && !list.includes(filters().model) ? [filters().model, ...list] : list
  })
  const modelChoices = createMemo(() => ["all", ...models()])

  const cycleProvider = () => {
    const choices = providerChoices()
    const current = filters().provider
    const index = choices.indexOf(current)
    const provider = choices[(index + 1) % choices.length] ?? "all"
    const available = modelOptions(allRows(), provider)
    const model = filters().model === "all" || available.includes(filters().model) ? filters().model : "all"
    update({ provider, model })
  }

  const cycleModel = () => {
    const choices = modelChoices()
    const current = filters().model
    const index = choices.indexOf(current)
    update({ model: choices[(index + 1) % choices.length] ?? "all" })
  }

  const cycleSort = () => {
    const index = SORT_KEYS.indexOf(filters().sort)
    update({ sort: SORT_KEYS[(index + 1) % SORT_KEYS.length] ?? "total" })
  }

  const toggleDirection = () => update({ direction: filters().direction === "desc" ? "asc" : "desc" })
  const toggleCost = () => update({ cost: !filters().cost })
  const toggleExact = () => update({ exact: !filters().exact })
  const refresh = () => void load()

  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      { bind: "escape", run: () => context.ui.dialog.clear() },
      { bind: "1", run: () => selectRange("rolling") },
      { bind: "2", run: () => selectRange("week") },
      { bind: "3", run: () => selectRange("month") },
      { bind: "4", run: () => selectRange("all") },
      { bind: "p", run: cycleProvider },
      { bind: "m", run: cycleModel },
      { bind: "s", run: cycleSort },
      { bind: "shift+s", run: toggleDirection },
      { bind: "c", run: toggleCost },
      { bind: "t", run: toggleExact },
      { bind: "r", run: refresh },
    ],
  }))

  onMount(() => {
    void load()
    tickTimer = setInterval(() => setNow(Date.now()), TICK_MS)
  })

  onCleanup(() => {
    disposed = true
    requestID += 1
    if (tickTimer) clearInterval(tickTimer)
  })

  const width = createMemo(() => Math.max(60, Math.min(112, dimensions().width - 8)))
  const showReasoning = createMemo(() => width() >= (filters().cost ? 120 : 108))
  const showCacheWrite = createMemo(() => width() >= (filters().cost ? 104 : 96))
  const showSteps = createMemo(() => width() >= 88)
  const showCost = createMemo(() => filters().cost)

  const columns = createMemo<Column[]>(() => {
    const base: Column[] = [
      { key: "provider", label: "Provider", width: 12, align: "left" },
      { key: "model", label: "Model", width: 14, align: "left" },
      { key: "input", label: "Input", width: 9, align: "right" },
      { key: "output", label: "Output", width: 8, align: "right" },
    ]
    if (showReasoning()) base.push({ key: "reasoning", label: "Reasoning", width: 9, align: "right" })
    base.push({ key: "cacheRead", label: "Cache R", width: 10, align: "right" })
    if (showCacheWrite()) base.push({ key: "cacheWrite", label: "Cache W", width: 10, align: "right" })
    base.push({ key: "total", label: "Total", width: 10, align: "right" })
    if (showSteps()) base.push({ key: "steps", label: "Steps", width: 6, align: "right" })
    if (showCost()) base.push({ key: "cost", label: "Cost*", width: 9, align: "right" })

    const fixed = base.reduce((sum, column) => sum + (column.key === "model" ? 0 : column.width), 0)
    const gaps = base.length - 1
    const modelWidth = Math.max(14, width() - fixed - gaps)
    return base.map((column) => (column.key === "model" ? { ...column, width: modelWidth } : column))
  })

  const tableHeight = createMemo(() => {
    const available = Math.max(5, Math.min(22, dimensions().height - (filters().cost ? 25 : 24)))
    return Math.min(available, Math.max(5, rows().length))
  })

  return (
    <box flexDirection="column" width={width()} gap={0}>
      <TokenHeader
        usage={usage()}
        usageError={usageError()}
        window={activeWindow()}
        timezone={timezone}
        updatedAt={updatedAt()}
        now={now()}
      />
      <FilterBar filters={filters()} />
      <TableHeader columns={columns()} />
      <box height={tableHeight()} width="100%">
        <Show
          when={!statsError()}
          fallback={<ErrorState text={statsError() ?? "Could not load local usage."} />}
        >
          <Show when={!loading()} fallback={<LoadingState />}>
            <Show when={rows().length > 0} fallback={<EmptyState provider={filters().provider} />}>
              <scrollbox
                width="100%"
                height="100%"
                focused={true}
                scrollX={false}
                contentOptions={{ flexDirection: "column" }}
              >
                <For each={rows()}>
                  {(row) => <TableRow cells={rowCells(columns(), row, filters().exact)} />}
                </For>
              </scrollbox>
            </Show>
          </Show>
        </Show>
      </box>
      <TotalArea
        columns={columns()}
        totals={totals()}
        count={rows().length}
        exact={filters().exact}
        visible={!loading() && !statsError()}
      />
      <Show when={filters().cost}>
        <text fg={context.theme.text.muted}>* Cost is an estimated list price, not your Go subscription charge.</text>
      </Show>
      <text fg={context.theme.text.muted} wrapMode="none">
        1-4 range · p provider · m model · s sort · S direction · c cost · t exact · r refresh · Esc close
      </text>
    </box>
  )
}

function TokenHeader(props: {
  usage: UsageResult | undefined
  usageError: string | undefined
  window: RangeWindow
  timezone: string
  updatedAt: number | undefined
  now: number
}) {
  const context = usePlugin()
  const muted = context.theme.text.muted
  const base = context.theme.text.base

  return (
    <box flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={base} attributes={TextAttributes.BOLD}>
          Token usage
        </text>
        <text fg={muted}>{props.updatedAt === undefined ? "Gathering…" : `Updated ${formatClock(props.updatedAt)}`}</text>
      </box>
      <text fg={muted}>Official Go quota (% of allowance)</text>
      <Show
        when={props.usage}
        fallback={<text fg={props.usageError === undefined ? muted : RED}>Go quota: {props.usageError ?? "loading…"}</text>}
      >
        {(usage) => (
          <>
            <UsageRow
              label="Rolling"
              window={() => usage().usage.rolling}
              now={() => props.now}
              dim={() => usage().stale === true}
            />
            <UsageRow
              label="Weekly"
              window={() => usage().usage.weekly}
              now={() => props.now}
              dim={() => usage().stale === true}
            />
            <UsageRow
              label="Monthly"
              window={() => usage().usage.monthly}
              now={() => props.now}
              dim={() => usage().stale === true}
            />
          </>
        )}
      </Show>
      <text fg={props.window.approximate ? YELLOW : muted}>{describeRange(props.window, props.timezone)}</text>
      <text fg={muted}>Local stats · this OpenCode server only · includes subagents</text>
    </box>
  )
}

function FilterBar(props: { filters: Filters }) {
  const context = usePlugin()
  const muted = context.theme.text.muted
  const base = context.theme.text.base

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={muted}>Range</text>
        <For each={RANGE_OPTIONS}>
          {(option) => (
            <text
              fg={props.filters.range === option.key ? base : muted}
              attributes={props.filters.range === option.key ? TextAttributes.BOLD : undefined}
            >
              {option.label}
            </text>
          )}
        </For>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={muted}>Provider [p]</text>
        <text fg={base}>{props.filters.provider}</text>
        <text fg={muted}>· Model [m]</text>
        <text fg={base}>{shorten(props.filters.model, 24)}</text>
        <text fg={muted}>· Sort [s]</text>
        <text fg={base}>
          {SORT_LABELS[props.filters.sort]} {props.filters.direction === "desc" ? "↓" : "↑"}
        </text>
        <text fg={muted}>· Cost [c]</text>
        <text fg={base}>{props.filters.cost ? "on" : "off"}</text>
        <text fg={muted}>· Exact [t]</text>
        <text fg={base}>{props.filters.exact ? "on" : "off"}</text>
      </box>
    </box>
  )
}

type ColumnKey =
  | "provider"
  | "model"
  | "input"
  | "output"
  | "reasoning"
  | "cacheRead"
  | "cacheWrite"
  | "total"
  | "steps"
  | "cost"

type Column = {
  key: ColumnKey
  label: string
  width: number
  align: "left" | "right"
}

type Cell = {
  text: string
  width: number
  align: "left" | "right"
  color?: string
  bold?: boolean
}

function TableHeader(props: { columns: readonly Column[] }) {
  return <TableRow cells={props.columns.map((column) => cell(column.label, column))} muted={true} />
}

function TableRow(props: { cells: readonly Cell[]; muted?: boolean; bold?: boolean }) {
  const context = usePlugin()
  const defaultColor = () => (props.muted ? context.theme.text.muted : context.theme.text.base)
  const bold = () => props.bold === true
  return (
    <box flexDirection="row" gap={1} height={1}>
      <For each={props.cells}>
        {(item) => (
          <box width={item.width} flexShrink={0}>
            <text
              fg={item.color ?? defaultColor()}
              attributes={bold() || item.bold === true ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {item.align === "left" ? truncate(item.text, item.width) : padStart(item.text, item.width)}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

function TotalArea(props: {
  columns: readonly Column[]
  totals: TokenTotals
  count: number
  exact: boolean
  visible: boolean
}) {
  const context = usePlugin()
  const muted = context.theme.text.muted
  const width = () => props.columns.reduce((sum, column) => sum + column.width, 0) + props.columns.length - 1
  return (
    <box height={2} flexDirection="column">
      <Show when={props.visible} fallback={<text fg={muted}> </text>}>
        <text fg={muted}>{"─".repeat(width())}</text>
        <TableRow cells={totalCells(props.columns, props.totals, props.count, props.exact)} bold={true} />
      </Show>
    </box>
  )
}

function LoadingState() {
  const context = usePlugin()
  return (
    <box height="100%" width="100%" alignItems="center" justifyContent="center">
      <text fg={context.theme.text.muted}>Gathering local usage…</text>
    </box>
  )
}

function EmptyState(props: { provider: string }) {
  const context = usePlugin()
  const muted = context.theme.text.muted
  return (
    <box height="100%" width="100%" flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
      <text fg={muted}>No usage for this range and filter.</text>
      <text fg={muted}>
        {props.provider === DEFAULT_PROVIDER
          ? "No opencode-go usage here. Press p for all providers."
          : "Press p to change provider, or 1-4 to change the range."}
      </text>
    </box>
  )
}

function ErrorState(props: { text: string }) {
  const context = usePlugin()
  return (
    <box height="100%" width="100%" flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
      <text fg={RED} wrapMode="word">
        {props.text}
      </text>
      <text fg={context.theme.text.muted}>Press r to retry.</text>
    </box>
  )
}

function cell(text: string, column: Column, color?: string): Cell {
  return { text, width: column.width, align: column.align, ...(color === undefined ? {} : { color }) }
}

function rowCells(columns: readonly Column[], row: TokenRow, exact: boolean): Cell[] {
  return columns.map((column) => {
    switch (column.key) {
      case "provider":
        return cell(row.providerID, column)
      case "model":
        return cell(row.modelID, column)
      case "input":
        return cell(formatTokens(row.input, exact), column)
      case "output":
        return cell(formatTokens(row.output, exact), column)
      case "reasoning":
        return cell(formatTokens(row.reasoning, exact), column)
      case "cacheRead":
        return cell(formatTokens(row.cacheRead, exact), column)
      case "cacheWrite":
        return cell(formatTokens(row.cacheWrite, exact), column)
      case "total":
        return cell(formatTokens(row.total, exact), column)
      case "steps":
        return cell(formatTokens(row.steps, true), column)
      case "cost":
        return cell(formatCost(row.cost), column)
    }
  })
}

function totalCells(columns: readonly Column[], totals: TokenTotals, count: number, exact: boolean): Cell[] {
  return columns.map((column) => {
    switch (column.key) {
      case "provider":
        return cell("Total", column)
      case "model":
        return cell(`${count} model${count === 1 ? "" : "s"}`, column)
      case "input":
        return cell(formatTokens(totals.input, exact), column)
      case "output":
        return cell(formatTokens(totals.output, exact), column)
      case "reasoning":
        return cell(formatTokens(totals.reasoning, exact), column)
      case "cacheRead":
        return cell(formatTokens(totals.cacheRead, exact), column)
      case "cacheWrite":
        return cell(formatTokens(totals.cacheWrite, exact), column)
      case "total":
        return cell(formatTokens(totals.total, exact), column)
      case "steps":
        return cell(formatTokens(totals.steps, true), column)
      case "cost":
        return cell(formatCost(totals.cost), column)
    }
  })
}

function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value.padEnd(width)
  if (width === 1) return "…"
  return `${value.slice(0, width - 1)}…`
}

function shorten(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value
  if (width === 1) return "…"
  return `${value.slice(0, width - 1)}…`
}

function padStart(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width)
  return value.padStart(width)
}

function formatClock(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms))
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "Timed out loading local usage."
    if (error.name === "AbortError") return "Loading was cancelled."
    if (error.message.length > 0) return error.message
  }
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined
  if (typeof record?.message === "string" && record.message.length > 0) return record.message
  return "Could not load local usage."
}
