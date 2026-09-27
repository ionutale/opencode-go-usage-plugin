import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { Show, createSignal } from "solid-js";
import { GoUsage } from "../src/rpc.ts";
import { barSegments, describeRpcError, formatResetsIn, usageColor } from "../src/usage.ts";
const REFRESH_MS = 30_000;
const TICK_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
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