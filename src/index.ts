import { Plugin } from "@opencode/plugin"
import { createAccountsService, extractKey, type AccountsContext } from "./accounts"
import { failover } from "./failover"
import { GoUsage } from "./rpc"
import { UsageError, createUsageService } from "./service"
import { ERROR_TEXT } from "./usage"

export { extractKey }

const PROVIDER = "opencode-go"

export default Plugin.define({
  id: "opencode-go-usage",
  async setup(ctx) {
    const service = createUsageService({
      resolveKey: async () => {
        const connection = await ctx.integration.connection.active(PROVIDER)
        if (!connection) return undefined
        return extractKey(await ctx.integration.connection.resolve(connection))
      },
    })
    const accounts = createAccountsService(ctx as unknown as AccountsContext, { provider: PROVIDER })

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
      getAll: async (_input, context) => accounts.getAll(context.signal),
    })

    // The failover half shares this plugin's options and hooks the same context.
    await failover.setup(ctx)
  },
})
