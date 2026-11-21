import { execFileSync } from "node:child_process"
import { chromium } from "@playwright/test"

const output = execFileSync("opencode", ["pair"], { encoding: "utf8" })
const url = output.match(/https?:\/\/\S+\/auth\/connect\/\S+/)?.[0]
if (!url) throw new Error("no pairing link in: " + output)

const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(5000)

console.log("url:", page.url())
console.log("--- body ---")
console.log((await page.locator("body").innerText()).slice(0, 2000))

const labels = await page.locator("button").evaluateAll((nodes) =>
  nodes.map((node) => ({
    aria: node.getAttribute("aria-label"),
    title: node.getAttribute("title"),
    text: (node.textContent ?? "").trim().slice(0, 50),
  })).filter((entry) => entry.aria || entry.title || entry.text).slice(0, 50),
)
console.log("--- buttons ---")
console.log(JSON.stringify(labels, null, 2))

await page.screenshot({ path: "/private/var/folders/j7/sjlw7b1579j821nvs72mph5h0000gn/T/opencode/probe-paired.png" })
await browser.close()
