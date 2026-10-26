import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { GoUsage } from "../src/rpc.ts";
import { aggregateModels, describeRange, filterRows, formatCost, formatTokens, modelOptions, providerOptions, rangeWindow, sortRows, sumRows } from "../src/tokens.ts";
import { RED, YELLOW, barSegments, describeRpcError, formatResetsIn, usageColor } from "../src/usage.ts";
const REFRESH_MS = 30_000;
const TICK_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const QUOTA_TIMEOUT_MS = 5_000;
const STATS_TIMEOUT_MS = 30_000;
const DEFAULT_PROVIDER = "opencode-go";
const RANGE_OPTIONS = [{
  key: "rolling",
  label: "1 Rolling"
}, {
  key: "week",
  label: "2 Week"
}, {
  key: "month",
  label: "3 Month"
}, {
  key: "all",
  label: "4 All"
}];
const SORT_KEYS = ["total", "input", "output", "cacheRead", "cacheWrite", "steps", "cost", "reasoning"];
const SORT_LABELS = {
  total: "Total",
  input: "Input",
  output: "Output",
  reasoning: "Reasoning",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  steps: "Steps",
  cost: "Cost"
};
const DEFAULT_FILTERS = {
  range: "month",
  provider: DEFAULT_PROVIDER,
  model: "all",
  sort: "total",
  direction: "desc",
  cost: false,
  exact: false
};

// TUI-session memory: reopening /tokens keeps the last view, a fresh TUI resets it.
let rememberedFilters = {
  ...DEFAULT_FILTERS
};
export default Plugin.define({
  id: "opencode-go-usage.tui",
  setup(context) {
    const rpc = context.client.rpc(GoUsage);
    const [state, setState] = createSignal({
      phase: "loading"
    });
    const [now, setNow] = createSignal(Date.now());
    const refresh = async () => {
      try {
        // JSON-Schema RPC output types as `unknown`; the server contract fixes the shape.
        const location = context.location ?? context.data.location.default();
        const result = await rpc.get({}, {
          location,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        setState({
          phase: "ok",
          result: result
        });
      } catch (error) {
        setState({
          phase: "error",
          text: describeRpcError(error)
        });
      }
    };
    void refresh();
    const refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
    const tickTimer = setInterval(() => setNow(Date.now()), TICK_MS);
    context.ui.slot({
      append: "sidebar.footer",
      render: () => _$createComponent(UsageBlock, {
        state: state,
        now: now
      })
    });
    const openTokens = () => {
      context.ui.dialog.clear();
      context.ui.dialog.show(() => _$createComponent(TokensDialog, {}));
      // `show` replaces the dialog and resets its presentation to medium; set
      // the requested xlarge, centered presentation after the replace.
      context.ui.dialog.set({
        size: "xlarge",
        centered: true
      });
    };
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [{
        id: "opencode-go-usage.tokens",
        title: "Go usage: tokens by model",
        group: "Go usage",
        palette: true,
        slash: {
          name: "tokens"
        },
        run: openTokens
      }]
    }));
    return () => {
      clearInterval(refreshTimer);
      clearInterval(tickTimer);
    };
  }
});
function UsageBlock(props) {
  const context = usePlugin();
  const muted = () => context.theme.text.muted;
  const errorState = () => {
    const state = props.state();
    return state.phase === "error" ? state : undefined;
  };
  const okState = () => {
    const state = props.state();
    return state.phase === "ok" ? state : undefined;
  };
  return [_$createComponent(Show, {
    get when() {
      return props.state().phase === "loading";
    },
    get children() {
      var _el$ = _$createElement("text");
      _$insertNode(_el$, _$createTextNode(`Go usage: loading…`));
      _$effect(_$p => _$setProp(_el$, "fg", muted(), _$p));
      return _el$;
    }
  }), _$createComponent(Show, {
    get when() {
      return errorState();
    },
    children: state => (() => {
      var _el$3 = _$createElement("text"),
        _el$4 = _$createTextNode(`Go usage: `);
      _$insertNode(_el$3, _el$4);
      _$insert(_el$3, () => state().text, null);
      _$effect(_$p => _$setProp(_el$3, "fg", muted(), _$p));
      return _el$3;
    })()
  }), _$createComponent(Show, {
    get when() {
      return okState();
    },
    children: state => {
      const stale = () => state().result.stale === true;
      return (() => {
        var _el$5 = _$createElement("box");
        _$setProp(_el$5, "flexDirection", "column");
        _$insert(_el$5, _$createComponent(UsageRow, {
          label: "Rolling",
          window: () => state().result.usage.rolling,
          get now() {
            return props.now;
          },
          dim: stale
        }), null);
        _$insert(_el$5, _$createComponent(UsageRow, {
          label: "Weekly",
          window: () => state().result.usage.weekly,
          get now() {
            return props.now;
          },
          dim: stale
        }), null);
        _$insert(_el$5, _$createComponent(UsageRow, {
          label: "Monthly",
          window: () => state().result.usage.monthly,
          get now() {
            return props.now;
          },
          dim: stale
        }), null);
        return _el$5;
      })();
    }
  })];
}
function UsageRow(props) {
  const context = usePlugin();
  const accent = () => props.dim() ? context.theme.text.muted : usageColor(props.window().percent);
  const percent = () => String(Math.round(props.window().percent)).padStart(3);
  return (() => {
    var _el$6 = _$createElement("box"),
      _el$7 = _$createElement("text"),
      _el$8 = _$createElement("text"),
      _el$9 = _$createElement("text"),
      _el$0 = _$createElement("text");
    _$insertNode(_el$6, _el$7);
    _$insertNode(_el$6, _el$8);
    _$insertNode(_el$6, _el$9);
    _$insertNode(_el$6, _el$0);
    _$setProp(_el$6, "flexDirection", "row");
    _$insert(_el$7, () => props.label.padEnd(9));
    _$insert(_el$8, () => barSegments(props.window().percent));
    _$insert(_el$9, () => `  ${percent()}%`);
    _$insert(_el$0, () => `  ${formatResetsIn(props.window().resetsAt, props.now())}`);
    _$effect(_p$ => {
      var _v$ = context.theme.text.muted,
        _v$2 = accent(),
        _v$3 = accent(),
        _v$4 = context.theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$7, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$8, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$9, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$0, "fg", _v$4, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$6;
  })();
}

/**
 * The /tokens modal. It intentionally lives in this file: the package's
 * build script transforms only src/tui.tsx, so JSX in a sibling file would
 * not compile for packaged installs.
 */
function TokensDialog() {
  const context = usePlugin();
  const dimensions = useTerminalDimensions();
  const rpc = context.client.rpc(GoUsage);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [filters, setFilters] = createSignal({
    ...rememberedFilters
  });
  const [usage, setUsage] = createSignal();
  const [usageError, setUsageError] = createSignal();
  const [stats, setStats] = createSignal();
  const [statsError, setStatsError] = createSignal();
  const [loading, setLoading] = createSignal(true);
  const [updatedAt, setUpdatedAt] = createSignal();
  const [queryNow, setQueryNow] = createSignal(Date.now());
  const [now, setNow] = createSignal(Date.now());
  let requestID = 0;
  let disposed = false;
  let tickTimer;
  const update = patch => {
    const next = {
      ...filters(),
      ...patch
    };
    setFilters(next);
    rememberedFilters = next;
  };
  const loadQuota = async () => {
    try {
      const location = context.location ?? context.data.location.default();
      const result = await rpc.get({}, {
        location,
        signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS)
      });
      if (disposed) return;
      setUsage(result);
      setUsageError(undefined);
    } catch (error) {
      if (disposed) return;
      setUsage(undefined);
      setUsageError(describeRpcError(error));
    }
  };
  const loadStats = async () => {
    if (disposed) return;
    const id = ++requestID;
    const at = Date.now();
    setQueryNow(at);
    setLoading(true);
    setStatsError(undefined);
    setStats(undefined);
    setUpdatedAt(undefined);
    const activeWindow = rangeWindow(filters().range, usage(), at);
    try {
      const result = await context.client.session.stats({
        from: activeWindow.from,
        to: activeWindow.to,
        timezone,
        tools: "none"
      }, {
        signal: AbortSignal.timeout(STATS_TIMEOUT_MS)
      });
      if (disposed || id !== requestID) return;
      setStats(result);
      setUpdatedAt(Date.now());
    } catch (error) {
      if (disposed || id !== requestID) return;
      setStatsError(describeError(error));
    } finally {
      if (!disposed && id === requestID) setLoading(false);
    }
  };
  const load = async () => {
    await loadQuota();
    if (disposed) return;
    await loadStats();
  };
  const selectRange = range => {
    if (filters().range === range) return;
    update({
      range
    });
    void loadStats();
  };
  const allRows = createMemo(() => aggregateModels(stats()?.models ?? []));
  const rows = createMemo(() => sortRows(filterRows(allRows(), filters().provider, filters().model), filters().sort, filters().direction));
  const totals = createMemo(() => sumRows(rows()));
  const activeWindow = createMemo(() => rangeWindow(filters().range, usage(), queryNow()));
  const providers = createMemo(() => {
    const list = providerOptions(allRows());
    return filters().provider !== "all" && !list.includes(filters().provider) ? [filters().provider, ...list] : list;
  });
  const providerChoices = createMemo(() => ["all", ...providers()]);
  const models = createMemo(() => {
    const list = modelOptions(allRows(), filters().provider);
    return filters().model !== "all" && !list.includes(filters().model) ? [filters().model, ...list] : list;
  });
  const modelChoices = createMemo(() => ["all", ...models()]);
  const cycleProvider = () => {
    const choices = providerChoices();
    const current = filters().provider;
    const index = choices.indexOf(current);
    const provider = choices[(index + 1) % choices.length] ?? "all";
    const available = modelOptions(allRows(), provider);
    const model = filters().model === "all" || available.includes(filters().model) ? filters().model : "all";
    update({
      provider,
      model
    });
  };
  const cycleModel = () => {
    const choices = modelChoices();
    const current = filters().model;
    const index = choices.indexOf(current);
    update({
      model: choices[(index + 1) % choices.length] ?? "all"
    });
  };
  const cycleSort = () => {
    const index = SORT_KEYS.indexOf(filters().sort);
    update({
      sort: SORT_KEYS[(index + 1) % SORT_KEYS.length] ?? "total"
    });
  };
  const toggleDirection = () => update({
    direction: filters().direction === "desc" ? "asc" : "desc"
  });
  const toggleCost = () => update({
    cost: !filters().cost
  });
  const toggleExact = () => update({
    exact: !filters().exact
  });
  const refresh = () => void load();
  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [{
      bind: "escape",
      run: () => context.ui.dialog.clear()
    }, {
      bind: "1",
      run: () => selectRange("rolling")
    }, {
      bind: "2",
      run: () => selectRange("week")
    }, {
      bind: "3",
      run: () => selectRange("month")
    }, {
      bind: "4",
      run: () => selectRange("all")
    }, {
      bind: "p",
      run: cycleProvider
    }, {
      bind: "m",
      run: cycleModel
    }, {
      bind: "s",
      run: cycleSort
    }, {
      bind: "shift+s",
      run: toggleDirection
    }, {
      bind: "c",
      run: toggleCost
    }, {
      bind: "t",
      run: toggleExact
    }, {
      bind: "r",
      run: refresh
    }]
  }));
  onMount(() => {
    void load();
    tickTimer = setInterval(() => setNow(Date.now()), TICK_MS);
  });
  onCleanup(() => {
    disposed = true;
    requestID += 1;
    if (tickTimer) clearInterval(tickTimer);
  });
  const width = createMemo(() => Math.max(60, Math.min(112, dimensions().width - 8)));
  const showReasoning = createMemo(() => width() >= (filters().cost ? 120 : 108));
  const showCacheWrite = createMemo(() => width() >= (filters().cost ? 104 : 96));
  const showSteps = createMemo(() => width() >= 88);
  const showCost = createMemo(() => filters().cost);
  const columns = createMemo(() => {
    const base = [{
      key: "provider",
      label: "Provider",
      width: 12,
      align: "left"
    }, {
      key: "model",
      label: "Model",
      width: 14,
      align: "left"
    }, {
      key: "input",
      label: "Input",
      width: 9,
      align: "right"
    }, {
      key: "output",
      label: "Output",
      width: 8,
      align: "right"
    }];
    if (showReasoning()) base.push({
      key: "reasoning",
      label: "Reasoning",
      width: 9,
      align: "right"
    });
    base.push({
      key: "cacheRead",
      label: "Cache R",
      width: 10,
      align: "right"
    });
    if (showCacheWrite()) base.push({
      key: "cacheWrite",
      label: "Cache W",
      width: 10,
      align: "right"
    });
    base.push({
      key: "total",
      label: "Total",
      width: 10,
      align: "right"
    });
    if (showSteps()) base.push({
      key: "steps",
      label: "Steps",
      width: 6,
      align: "right"
    });
    if (showCost()) base.push({
      key: "cost",
      label: "Cost*",
      width: 9,
      align: "right"
    });
    const fixed = base.reduce((sum, column) => sum + (column.key === "model" ? 0 : column.width), 0);
    const gaps = base.length - 1;
    const modelWidth = Math.max(14, width() - fixed - gaps);
    return base.map(column => column.key === "model" ? {
      ...column,
      width: modelWidth
    } : column);
  });
  const tableHeight = createMemo(() => {
    const available = Math.max(5, Math.min(22, dimensions().height - (filters().cost ? 25 : 24)));
    return Math.min(available, Math.max(5, rows().length));
  });
  return (() => {
    var _el$1 = _$createElement("box"),
      _el$10 = _$createElement("box"),
      _el$14 = _$createElement("text");
    _$insertNode(_el$1, _el$10);
    _$insertNode(_el$1, _el$14);
    _$setProp(_el$1, "flexDirection", "column");
    _$setProp(_el$1, "gap", 0);
    _$insert(_el$1, _$createComponent(TokenHeader, {
      get usage() {
        return usage();
      },
      get usageError() {
        return usageError();
      },
      get window() {
        return activeWindow();
      },
      timezone: timezone,
      get updatedAt() {
        return updatedAt();
      },
      get now() {
        return now();
      }
    }), _el$10);
    _$insert(_el$1, _$createComponent(FilterBar, {
      get filters() {
        return filters();
      }
    }), _el$10);
    _$insert(_el$1, _$createComponent(TableHeader, {
      get columns() {
        return columns();
      }
    }), _el$10);
    _$setProp(_el$10, "width", "100%");
    _$insert(_el$10, _$createComponent(Show, {
      get when() {
        return !statsError();
      },
      get fallback() {
        return _$createComponent(ErrorState, {
          get text() {
            return statsError() ?? "Could not load local usage.";
          }
        });
      },
      get children() {
        return _$createComponent(Show, {
          get when() {
            return !loading();
          },
          get fallback() {
            return _$createComponent(LoadingState, {});
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return rows().length > 0;
              },
              get fallback() {
                return _$createComponent(EmptyState, {
                  get provider() {
                    return filters().provider;
                  }
                });
              },
              get children() {
                var _el$11 = _$createElement("scrollbox");
                _$setProp(_el$11, "width", "100%");
                _$setProp(_el$11, "height", "100%");
                _$setProp(_el$11, "focused", true);
                _$setProp(_el$11, "scrollX", false);
                _$setProp(_el$11, "contentOptions", {
                  flexDirection: "column"
                });
                _$insert(_el$11, _$createComponent(For, {
                  get each() {
                    return rows();
                  },
                  children: row => _$createComponent(TableRow, {
                    get cells() {
                      return rowCells(columns(), row, filters().exact);
                    }
                  })
                }));
                return _el$11;
              }
            });
          }
        });
      }
    }));
    _$insert(_el$1, _$createComponent(TotalArea, {
      get columns() {
        return columns();
      },
      get totals() {
        return totals();
      },
      get count() {
        return rows().length;
      },
      get exact() {
        return filters().exact;
      },
      get visible() {
        return _$memo(() => !!!loading())() && !statsError();
      }
    }), _el$14);
    _$insert(_el$1, _$createComponent(Show, {
      get when() {
        return filters().cost;
      },
      get children() {
        var _el$12 = _$createElement("text");
        _$insertNode(_el$12, _$createTextNode(`* Cost is an estimated list price, not your Go subscription charge.`));
        _$effect(_$p => _$setProp(_el$12, "fg", context.theme.text.muted, _$p));
        return _el$12;
      }
    }), _el$14);
    _$insertNode(_el$14, _$createTextNode(`1-4 range · p provider · m model · s sort · S direction · c cost · t exact · r refresh · Esc close`));
    _$setProp(_el$14, "wrapMode", "none");
    _$effect(_p$ => {
      var _v$5 = width(),
        _v$6 = tableHeight(),
        _v$7 = context.theme.text.muted;
      _v$5 !== _p$.e && (_p$.e = _$setProp(_el$1, "width", _v$5, _p$.e));
      _v$6 !== _p$.t && (_p$.t = _$setProp(_el$10, "height", _v$6, _p$.t));
      _v$7 !== _p$.a && (_p$.a = _$setProp(_el$14, "fg", _v$7, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$1;
  })();
}
function TokenHeader(props) {
  const context = usePlugin();
  const muted = context.theme.text.muted;
  const base = context.theme.text.base;
  return (() => {
    var _el$16 = _$createElement("box"),
      _el$17 = _$createElement("box"),
      _el$18 = _$createElement("text"),
      _el$20 = _$createElement("text"),
      _el$21 = _$createElement("text"),
      _el$23 = _$createElement("text"),
      _el$24 = _$createElement("text");
    _$insertNode(_el$16, _el$17);
    _$insertNode(_el$16, _el$21);
    _$insertNode(_el$16, _el$23);
    _$insertNode(_el$16, _el$24);
    _$setProp(_el$16, "flexDirection", "column");
    _$insertNode(_el$17, _el$18);
    _$insertNode(_el$17, _el$20);
    _$setProp(_el$17, "flexDirection", "row");
    _$setProp(_el$17, "justifyContent", "space-between");
    _$insertNode(_el$18, _$createTextNode(`Token usage`));
    _$setProp(_el$18, "fg", base);
    _$setProp(_el$20, "fg", muted);
    _$insert(_el$20, (() => {
      var _c$ = _$memo(() => props.updatedAt === undefined);
      return () => _c$() ? "Gathering…" : `Updated ${formatClock(props.updatedAt)}`;
    })());
    _$insertNode(_el$21, _$createTextNode(`Official Go quota (% of allowance)`));
    _$setProp(_el$21, "fg", muted);
    _$insert(_el$16, _$createComponent(Show, {
      get when() {
        return props.usage;
      },
      get fallback() {
        return (() => {
          var _el$26 = _$createElement("text"),
            _el$27 = _$createTextNode(`Go quota: `);
          _$insertNode(_el$26, _el$27);
          _$insert(_el$26, () => props.usageError ?? "loading…", null);
          _$effect(_$p => _$setProp(_el$26, "fg", props.usageError === undefined ? muted : RED, _$p));
          return _el$26;
        })();
      },
      children: usage => [_$createComponent(UsageRow, {
        label: "Rolling",
        window: () => usage().usage.rolling,
        now: () => props.now,
        dim: () => usage().stale === true
      }), _$createComponent(UsageRow, {
        label: "Weekly",
        window: () => usage().usage.weekly,
        now: () => props.now,
        dim: () => usage().stale === true
      }), _$createComponent(UsageRow, {
        label: "Monthly",
        window: () => usage().usage.monthly,
        now: () => props.now,
        dim: () => usage().stale === true
      })]
    }), _el$23);
    _$insert(_el$23, () => describeRange(props.window, props.timezone));
    _$insertNode(_el$24, _$createTextNode(`Local stats · this OpenCode server only · includes subagents`));
    _$setProp(_el$24, "fg", muted);
    _$effect(_p$ => {
      var _v$8 = TextAttributes.BOLD,
        _v$9 = props.window.approximate ? YELLOW : muted;
      _v$8 !== _p$.e && (_p$.e = _$setProp(_el$18, "attributes", _v$8, _p$.e));
      _v$9 !== _p$.t && (_p$.t = _$setProp(_el$23, "fg", _v$9, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$16;
  })();
}
function FilterBar(props) {
  const context = usePlugin();
  const muted = context.theme.text.muted;
  const base = context.theme.text.base;
  return (() => {
    var _el$28 = _$createElement("box"),
      _el$29 = _$createElement("box"),
      _el$30 = _$createElement("text"),
      _el$32 = _$createElement("box"),
      _el$33 = _$createElement("text"),
      _el$35 = _$createElement("text"),
      _el$36 = _$createElement("text"),
      _el$38 = _$createElement("text"),
      _el$39 = _$createElement("text"),
      _el$41 = _$createElement("text"),
      _el$42 = _$createTextNode(` `),
      _el$43 = _$createElement("text"),
      _el$45 = _$createElement("text"),
      _el$46 = _$createElement("text"),
      _el$48 = _$createElement("text");
    _$insertNode(_el$28, _el$29);
    _$insertNode(_el$28, _el$32);
    _$setProp(_el$28, "flexDirection", "column");
    _$insertNode(_el$29, _el$30);
    _$setProp(_el$29, "flexDirection", "row");
    _$setProp(_el$29, "gap", 1);
    _$insertNode(_el$30, _$createTextNode(`Range`));
    _$setProp(_el$30, "fg", muted);
    _$insert(_el$29, _$createComponent(For, {
      each: RANGE_OPTIONS,
      children: option => (() => {
        var _el$49 = _$createElement("text");
        _$insert(_el$49, () => option.label);
        _$effect(_p$ => {
          var _v$0 = props.filters.range === option.key ? base : muted,
            _v$1 = props.filters.range === option.key ? TextAttributes.BOLD : undefined;
          _v$0 !== _p$.e && (_p$.e = _$setProp(_el$49, "fg", _v$0, _p$.e));
          _v$1 !== _p$.t && (_p$.t = _$setProp(_el$49, "attributes", _v$1, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$49;
      })()
    }), null);
    _$insertNode(_el$32, _el$33);
    _$insertNode(_el$32, _el$35);
    _$insertNode(_el$32, _el$36);
    _$insertNode(_el$32, _el$38);
    _$insertNode(_el$32, _el$39);
    _$insertNode(_el$32, _el$41);
    _$insertNode(_el$32, _el$43);
    _$insertNode(_el$32, _el$45);
    _$insertNode(_el$32, _el$46);
    _$insertNode(_el$32, _el$48);
    _$setProp(_el$32, "flexDirection", "row");
    _$setProp(_el$32, "gap", 1);
    _$insertNode(_el$33, _$createTextNode(`Provider [p]`));
    _$setProp(_el$33, "fg", muted);
    _$setProp(_el$35, "fg", base);
    _$insert(_el$35, () => props.filters.provider);
    _$insertNode(_el$36, _$createTextNode(`· Model [m]`));
    _$setProp(_el$36, "fg", muted);
    _$setProp(_el$38, "fg", base);
    _$insert(_el$38, () => shorten(props.filters.model, 24));
    _$insertNode(_el$39, _$createTextNode(`· Sort [s]`));
    _$setProp(_el$39, "fg", muted);
    _$insertNode(_el$41, _el$42);
    _$setProp(_el$41, "fg", base);
    _$insert(_el$41, () => SORT_LABELS[props.filters.sort], _el$42);
    _$insert(_el$41, () => props.filters.direction === "desc" ? "↓" : "↑", null);
    _$insertNode(_el$43, _$createTextNode(`· Cost [c]`));
    _$setProp(_el$43, "fg", muted);
    _$setProp(_el$45, "fg", base);
    _$insert(_el$45, () => props.filters.cost ? "on" : "off");
    _$insertNode(_el$46, _$createTextNode(`· Exact [t]`));
    _$setProp(_el$46, "fg", muted);
    _$setProp(_el$48, "fg", base);
    _$insert(_el$48, () => props.filters.exact ? "on" : "off");
    return _el$28;
  })();
}
function TableHeader(props) {
  return _$createComponent(TableRow, {
    get cells() {
      return props.columns.map(column => cell(column.label, column));
    },
    muted: true
  });
}
function TableRow(props) {
  const context = usePlugin();
  const defaultColor = () => props.muted ? context.theme.text.muted : context.theme.text.base;
  const bold = () => props.bold === true;
  return (() => {
    var _el$50 = _$createElement("box");
    _$setProp(_el$50, "flexDirection", "row");
    _$setProp(_el$50, "gap", 1);
    _$setProp(_el$50, "height", 1);
    _$insert(_el$50, _$createComponent(For, {
      get each() {
        return props.cells;
      },
      children: item => (() => {
        var _el$51 = _$createElement("box"),
          _el$52 = _$createElement("text");
        _$insertNode(_el$51, _el$52);
        _$setProp(_el$51, "flexShrink", 0);
        _$setProp(_el$52, "wrapMode", "none");
        _$insert(_el$52, (() => {
          var _c$2 = _$memo(() => item.align === "left");
          return () => _c$2() ? truncate(item.text, item.width) : padStart(item.text, item.width);
        })());
        _$effect(_p$ => {
          var _v$10 = item.width,
            _v$11 = item.color ?? defaultColor(),
            _v$12 = bold() || item.bold === true ? TextAttributes.BOLD : undefined;
          _v$10 !== _p$.e && (_p$.e = _$setProp(_el$51, "width", _v$10, _p$.e));
          _v$11 !== _p$.t && (_p$.t = _$setProp(_el$52, "fg", _v$11, _p$.t));
          _v$12 !== _p$.a && (_p$.a = _$setProp(_el$52, "attributes", _v$12, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$51;
      })()
    }));
    return _el$50;
  })();
}
function TotalArea(props) {
  const context = usePlugin();
  const muted = context.theme.text.muted;
  const width = () => props.columns.reduce((sum, column) => sum + column.width, 0) + props.columns.length - 1;
  return (() => {
    var _el$53 = _$createElement("box");
    _$setProp(_el$53, "height", 2);
    _$setProp(_el$53, "flexDirection", "column");
    _$insert(_el$53, _$createComponent(Show, {
      get when() {
        return props.visible;
      },
      get fallback() {
        return (() => {
          var _el$55 = _$createElement("text");
          _$insertNode(_el$55, _$createTextNode(` `));
          _$setProp(_el$55, "fg", muted);
          return _el$55;
        })();
      },
      get children() {
        return [(() => {
          var _el$54 = _$createElement("text");
          _$setProp(_el$54, "fg", muted);
          _$insert(_el$54, () => "─".repeat(width()));
          return _el$54;
        })(), _$createComponent(TableRow, {
          get cells() {
            return totalCells(props.columns, props.totals, props.count, props.exact);
          },
          bold: true
        })];
      }
    }));
    return _el$53;
  })();
}
function LoadingState() {
  const context = usePlugin();
  return (() => {
    var _el$57 = _$createElement("box"),
      _el$58 = _$createElement("text");
    _$insertNode(_el$57, _el$58);
    _$setProp(_el$57, "height", "100%");
    _$setProp(_el$57, "width", "100%");
    _$setProp(_el$57, "alignItems", "center");
    _$setProp(_el$57, "justifyContent", "center");
    _$insertNode(_el$58, _$createTextNode(`Gathering local usage…`));
    _$effect(_$p => _$setProp(_el$58, "fg", context.theme.text.muted, _$p));
    return _el$57;
  })();
}
function EmptyState(props) {
  const context = usePlugin();
  const muted = context.theme.text.muted;
  return (() => {
    var _el$60 = _$createElement("box"),
      _el$61 = _$createElement("text"),
      _el$63 = _$createElement("text");
    _$insertNode(_el$60, _el$61);
    _$insertNode(_el$60, _el$63);
    _$setProp(_el$60, "height", "100%");
    _$setProp(_el$60, "width", "100%");
    _$setProp(_el$60, "flexDirection", "column");
    _$setProp(_el$60, "alignItems", "center");
    _$setProp(_el$60, "justifyContent", "center");
    _$setProp(_el$60, "gap", 1);
    _$insertNode(_el$61, _$createTextNode(`No usage for this range and filter.`));
    _$setProp(_el$61, "fg", muted);
    _$setProp(_el$63, "fg", muted);
    _$insert(_el$63, () => props.provider === DEFAULT_PROVIDER ? "No opencode-go usage here. Press p for all providers." : "Press p to change provider, or 1-4 to change the range.");
    return _el$60;
  })();
}
function ErrorState(props) {
  const context = usePlugin();
  return (() => {
    var _el$64 = _$createElement("box"),
      _el$65 = _$createElement("text"),
      _el$66 = _$createElement("text");
    _$insertNode(_el$64, _el$65);
    _$insertNode(_el$64, _el$66);
    _$setProp(_el$64, "height", "100%");
    _$setProp(_el$64, "width", "100%");
    _$setProp(_el$64, "flexDirection", "column");
    _$setProp(_el$64, "alignItems", "center");
    _$setProp(_el$64, "justifyContent", "center");
    _$setProp(_el$64, "gap", 1);
    _$setProp(_el$65, "fg", RED);
    _$setProp(_el$65, "wrapMode", "word");
    _$insert(_el$65, () => props.text);
    _$insertNode(_el$66, _$createTextNode(`Press r to retry.`));
    _$effect(_$p => _$setProp(_el$66, "fg", context.theme.text.muted, _$p));
    return _el$64;
  })();
}
function cell(text, column, color) {
  return {
    text,
    width: column.width,
    align: column.align,
    ...(color === undefined ? {} : {
      color
    })
  };
}
function rowCells(columns, row, exact) {
  return columns.map(column => {
    switch (column.key) {
      case "provider":
        return cell(row.providerID, column);
      case "model":
        return cell(row.modelID, column);
      case "input":
        return cell(formatTokens(row.input, exact), column);
      case "output":
        return cell(formatTokens(row.output, exact), column);
      case "reasoning":
        return cell(formatTokens(row.reasoning, exact), column);
      case "cacheRead":
        return cell(formatTokens(row.cacheRead, exact), column);
      case "cacheWrite":
        return cell(formatTokens(row.cacheWrite, exact), column);
      case "total":
        return cell(formatTokens(row.total, exact), column);
      case "steps":
        return cell(formatTokens(row.steps, true), column);
      case "cost":
        return cell(formatCost(row.cost), column);
    }
  });
}
function totalCells(columns, totals, count, exact) {
  return columns.map(column => {
    switch (column.key) {
      case "provider":
        return cell("Total", column);
      case "model":
        return cell(`${count} model${count === 1 ? "" : "s"}`, column);
      case "input":
        return cell(formatTokens(totals.input, exact), column);
      case "output":
        return cell(formatTokens(totals.output, exact), column);
      case "reasoning":
        return cell(formatTokens(totals.reasoning, exact), column);
      case "cacheRead":
        return cell(formatTokens(totals.cacheRead, exact), column);
      case "cacheWrite":
        return cell(formatTokens(totals.cacheWrite, exact), column);
      case "total":
        return cell(formatTokens(totals.total, exact), column);
      case "steps":
        return cell(formatTokens(totals.steps, true), column);
      case "cost":
        return cell(formatCost(totals.cost), column);
    }
  });
}
function truncate(value, width) {
  if (width <= 0) return "";
  if (value.length <= width) return value.padEnd(width);
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}
function shorten(value, width) {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}
function padStart(value, width) {
  if (value.length >= width) return value.slice(0, width);
  return value.padStart(width);
}
function formatClock(ms) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ms));
}
function describeError(error) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "Timed out loading local usage.";
    if (error.name === "AbortError") return "Loading was cancelled.";
    if (error.message.length > 0) return error.message;
  }
  const record = typeof error === "object" && error !== null ? error : undefined;
  if (typeof record?.message === "string" && record.message.length > 0) return record.message;
  return "Could not load local usage.";
}