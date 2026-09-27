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

const ERROR_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
} as const

export const GoUsage = Rpc.define({
  id: "go-usage",
  methods: {
    get: {
      // `Rpc.define` requires an input schema; an empty object is the "no input" shape.
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          usage: {
            type: "object",
            properties: {
              rolling: WINDOW_SCHEMA,
              weekly: WINDOW_SCHEMA,
              monthly: WINDOW_SCHEMA,
            },
            required: ["rolling", "weekly", "monthly"],
            additionalProperties: false,
          },
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
  },
  // `Rpc.define` requires an events map; this RPC declares none.
  events: {},
})
