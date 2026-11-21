import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const PREFIX = "[go-failover]"

export type Logger = (message: string) => void

export type LoggerOptions = {
  path: string
  now?: () => number
  append?: (path: string, text: string) => void
  mkdir?: (path: string) => void
  echo?: (message: string) => void
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? Date.now
  const append = options.append ?? ((path, text) => appendFileSync(path, text))
  const mkdir = options.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
  const echo = options.echo ?? ((message) => console.log(`${PREFIX} ${message}`))

  return (message) => {
    try {
      mkdir(dirname(options.path))
      append(options.path, `${new Date(now()).toISOString()} ${PREFIX} ${message}\n`)
    } catch {
      // A log line is never worth failing a turn over.
    }
    try {
      echo(message)
    } catch {
      // Same for the console: a closed pipe must not escape into a hook.
    }
  }
}
