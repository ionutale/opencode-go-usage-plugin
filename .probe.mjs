import { chromium } from "@playwright/test"

const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto("http://127.0.0.1:49374/", { waitUntil: "domcontentloaded" })
await page.waitForTimeout(4000)

console.log("url:", page.url())
const text = await page.locator("body").innerText()
console.log("--- body text (first 1500) ---")
console.log(text.slice(0, 1500))

const labels = await page.locator("button").evaluateAll((nodes) =>
  nodes.map((node) => ({
    aria: node.getAttribute("aria-label"),
    title: node.getAttribute("title"),
    text: (node.textContent ?? "").trim().slice(0, 40),
  })).filter((entry) => entry.aria || entry.title || entry.text).slice(0, 40),
)
console.log("--- buttons ---")
console.log(JSON.stringify(labels, null, 2))

await page.screenshot({ path: "/private/var/folders/j7/sjlw7b1579j821nvs72mph5h0000gn/T/opencode/web-probe.png", fullPage: false })
await browser.close()
