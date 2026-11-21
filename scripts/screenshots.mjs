// Renders the README previews from the same colors, thresholds, and layout the
// widget uses. Run with `pnpm screenshots`; writes docs/screenshots/*.png.
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

const OUT = resolve("docs/screenshots")
mkdirSync(OUT, { recursive: true })

const color = (percent) => (percent >= 75 ? "#ef4444" : percent >= 50 ? "#eab308" : "#22c55e")

function rings(rolling, weekly, monthly, size = 30) {
  const center = size / 2
  const specs = [
    { percent: rolling, radius: size * 0.383, color: color(rolling) },
    { percent: weekly, radius: size * 0.267, color: color(weekly) },
    { percent: monthly, radius: size * 0.15, color: color(monthly) },
  ]
  const stroke = size * 0.1
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${specs
      .map(({ percent, radius, color }) => {
        const circumference = 2 * Math.PI * radius
        const filled = (Math.min(100, Math.max(0, percent)) / 100) * circumference
        return `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${color}" stroke-opacity="0.18" stroke-width="${stroke}"/>
        <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
          stroke-dasharray="${filled} ${circumference - filled}" transform="rotate(-90 ${center} ${center})"/>`
      })
      .join("")}
  </svg>`
}

const icon = (path) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`

const header = `
<div id="header" class="stage">
  <div class="header">
    <button class="control" aria-label="Go usage">${rings(8, 67, 31)}</button>
    <button class="control">${icon('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6 3v10"/>')}</button>
    <button class="control">${icon('<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4"/><path d="M8 5.2h.01"/>')}</button>
    <button class="control">${icon('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.2 8.2l2 2 3.6-4"/>')}</button>
  </div>
</div>`

const row = (label, percent, countdown) => `
  <div class="row">
    <span class="muted">${label}</span>
    <span><span class="value" style="color:${color(percent)}">${percent}%</span><span class="muted"> · resets in ${countdown}</span></span>
  </div>`

const account = (name, active, rows, error) => `
  <div class="account">
    <div class="account-head">
      <span class="account-name">${name}</span>
      ${active ? '<span class="badge">Active</span>' : ""}
    </div>
    ${error ? `<span class="muted small">${error}</span>` : rows.join("")}
  </div>`

const dialog = `
<div id="dialog" class="stage">
  <div class="dialog">
    <div class="dialog-head">
      <span class="dialog-title">OpenCode Go usage</span>
      <span class="close">×</span>
    </div>
    ${account("Work", true, [
      row("Rolling", 8, "4h 0m"),
      row("Weekly", 67, "3d 0h"),
      row("Monthly", 31, "20d 0h"),
    ])}
    ${account("Personal", false, [
      row("Rolling", 72, "2h 0m"),
      row("Weekly", 31, "3d 0h"),
      row("Monthly", 88, "9d 0h"),
    ])}
    ${account("Backup", false, [], "not connected")}
  </div>
</div>`

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #101012; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; color: #ececec; }
  .stage { display: inline-block; padding: 22px; background: #101012; }
  .header { display: inline-flex; align-items: center; gap: 2px; padding: 6px; border: 1px solid #2a2a2e; border-radius: 10px; background: #17171a; }
  .control { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #8b8f96; }
  .dialog { width: 420px; padding: 16px; border-radius: 12px; background: #1c1c20; color: #ececec; box-shadow: 0 18px 50px rgba(0,0,0,.55); }
  .dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .dialog-title { font-size: 13px; font-weight: 600; }
  .close { color: #8b8f96; font-size: 16px; line-height: 1; }
  .account { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,.08); margin-top: 8px; }
  .account-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .account-name { font-size: 12px; font-weight: 600; }
  .badge { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: #30d158; background: rgba(48,209,88,.16); border-radius: 999px; padding: 1px 6px; }
  .row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 12px; }
  .muted { color: #9a9ea6; }
  .small { font-size: 12px; }
  .value { font-weight: 600; }
</style></head>
<body>${header}${dialog}</body></html>`

const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 })
await page.setContent(html)
await page.locator("#header").screenshot({ path: resolve(OUT, "header-rings.png") })
await page.locator("#dialog").screenshot({ path: resolve(OUT, "usage-dialog.png") })
await browser.close()
console.log("wrote docs/screenshots/header-rings.png and docs/screenshots/usage-dialog.png")
