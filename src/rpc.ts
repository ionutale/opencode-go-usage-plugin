import { Rpc } from "@opencode/plugin/rpc"

const WINDOW_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string" },
    percent: { type: "number" },
    resetsAt: { type: "string" },
  },
  required: ["status", "percent", "resetsAt"],
  additionalProperties: false,
} as const

const USAGE_SCHEMA = {
  type: "object",
  properties: {
    rolling: WINDOW_SCHEMA,
    weekly: WINDOW_SCHEMA,
    monthly: WINDOW_SCHEMA,
  },
  required: ["rolling", "weekly", "monthly"],
  additionalProperties: false,
} as const

const ACCOUNT_SCHEMA = {
  type: "object",
  properties: {
    credentialID: { type: "string" },
    label: { type: "string" },
    active: { type: "boolean" },
    usage: USAGE_SCHEMA,
    error: { type: "string" },
    fetchedAt: { type: "string" },
    stale: { type: "boolean" },
  },
  required: ["credentialID", "label", "active"],
  additionalProperties: false,
} as const

const ERROR_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
} as const

const NO_INPUT = { type: "object", additionalProperties: false } as const

export const GoUsage = Rpc.define({
  id: "go-usage",
  methods: {
    get: {
      // `Rpc.define` requires an input schema; an empty object is the "no input" shape.
      input: NO_INPUT,
      output: {
        type: "object",
        properties: {
          usage: USAGE_SCHEMA,
          fetchedAt: { type: "string" },
          stale: { type: "boolean" },
        },
        required: ["usage", "fetchedAt"],
        additionalProperties: false,
      },
      errors: {
        no_credential: ERROR_SCHEMA,
        unauthorized: ERROR_SCHEMA,
        forbidden: ERROR_SCHEMA,
        upstream: ERROR_SCHEMA,
      },
    },
    getAll: {
      // Every Go credential with its own usage. Per-account failures are carried
      // in the payload so one bad key never hides the others. `fresh` skips the
      // server cache, for the widget's click-to-refresh.
      input: {
        type: "object",
        properties: { fresh: { type: "boolean" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          accounts: { type: "array", items: ACCOUNT_SCHEMA },
        },
        required: ["accounts"],
        additionalProperties: false,
      },
    },
  },
  // `Rpc.define` requires an events map; this RPC declares none.
  events: {},
})
