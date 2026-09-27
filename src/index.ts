import { Plugin } from "@opencode/plugin"
import { GoUsage } from "./rpc"
import { UsageError, createUsageService } from "./service"
import { ERROR_TEXT } from "./usage"

export default Plugin.define({
  id: "opencode-go-usage",
  async setup(ctx) {
    const service = createUsageService({
      resolveKey: async () => {
        const connection = await ctx.integration.connection.active("opencode-go")
        if (!connection) return undefined
        return extractKey(await ctx.integration.connection.resolve(connection))
      },
    })

    await ctx.rpc.register(GoUsage, {
      get: async (_input, context) => {
        try {
          return await service.get(context.signal)
        } catch (error) {
          if (error instanceof UsageError) {
            return context.error(error.type, ERROR_TEXT[error.type] ?? error.message, { message: error.message })
          }
          throw error
        }
      },
    })
  },
})

/** Handles both a bare secret string and credential objects with a key-ish field. */
export function extractKey(credential: unknown): string | undefined {
  if (typeof credential === "string" && credential.length > 0) return credential
  if (typeof credential === "object" && credential !== null) {
    const record = credential as Record<string, unknown>
    for (const candidate of [record.key, record.apiKey, record.value]) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate
    }
  }
  return undefined
}
