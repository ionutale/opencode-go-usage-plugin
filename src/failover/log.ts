import { appendFileSync, chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DEFAULT_LOG_FILE } from "./config"

const PREFIX = "[go-failover]"

export type Logger = (message: string) => void

export type LoggerOptions = {
  path?: string
  now?: () => number
  append?: (path: string, text: string) => void
  mkdir?: (path: string) => void
  echo?: (message: string) => void
}

/** Strip control characters and line breaks so a label cannot forge log lines. */
export function sanitize(message: string): string {
  return message.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ")
}

function defaultAppend(path: string, text: string): void {
  appendFileSync(path, text, { mode: 0o600 })
  // `mode` only applies when the file is created; fix an existing broader mode.
  chmodSync(path, 0o600)
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const path = options.path ?? DEFAULT_LOG_FILE
  const now = options.now ?? Date.now
  const append = options.append ?? defaultAppend
  const mkdir = options.mkdir ?? ((dir) => mkdirSync(dir, { recursive: true }))
  const echo = options.echo ?? ((message) => console.log(`${PREFIX} ${message}`))

  return (message) => {
    const line = sanitize(message)
    try {
      mkdir(dirname(path))
      append(path, `${new Date(now()).toISOString()} ${PREFIX} ${line}\n`)
    } catch {
      // A log line is never worth failing a turn over.
    }
    try {
      echo(line)
    } catch {
      // Same for the console: a closed pipe must not escape into a hook.
    }
  }
}
