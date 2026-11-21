import { execFileSync } from "node:child_process"
import { chromium } from "@playwright/test"

const created = JSON.parse(
  execFileSync(
    "opencode",
    [
      "api",
      "post",
      "/api/session",
      "--data",
      JSON.stringify({ title: "OpenCode Go usage", location: { directory: "~/developer-playground" } }),
    ],
    { encoding: "utf8" },
  ),
)
const sessionID = created.data.id
console.log("fixture session:", sessionID)

const pairOutput = execFileSync("opencode", ["pair"], { encoding: "utf8" })
const pairUrl = pairOutput.match(/https?:\/\/\S+\/auth\/connect\/\S+/)?.[0]
if (!pairUrl) throw new Error("no pair link")

const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(pairUrl, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(3000)
await page.reload({ waitUntil: "domcontentloaded" })
await page.waitForTimeout(4000)

const body = await page.locator("body").innerText()
console.log("fixture listed:", body.includes("OpenCode Go usage"))

const entry = page.getByText("OpenCode Go usage", { exact: true }).first()
if (await entry.count()) {
  await entry.click()
  await page.waitForTimeout(2000)
  console.log("url after click:", page.url())
  const header = await page.locator("body").innerText()
  console.log("header text:", header.slice(0, 300).replaceAll("\n", " | "))
  await page.screenshot({
    path: "/private/var/folders/j7/sjlw7b1579j821nvs72mph5h0000gn/T/opencode/probe-session.png",
  })
}

await browser.close()
execFileSync("opencode", ["api", "delete", `/api/session/${sessionID}`])
console.log("fixture deleted")
