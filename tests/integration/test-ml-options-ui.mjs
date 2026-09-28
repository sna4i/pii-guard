// test-ml-options-ui.mjs — UI smoke for the Phase 0b ML toggle.
//
// Verifies:
//   1. The options page renders the new "ブラウザ内 ML 検出" card.
//   2. Clicking #ml-enabled (a real user-gesture click via Playwright)
//      triggers the chrome.permissions.request flow without a dialog
//      because the dev manifest pre-grants HF Hub origins.
//   3. ML_PREWARM fires automatically and the status pill flips to
//      the "✓ 準備完了" success state inside the configured timeout.
//   4. chrome.storage.local.mlEnabled is persisted to true.
//
// Re-toggling OFF must reset the status pill to "未有効" and flip
// the storage flag back to false.
//
// Usage:
//   cd tests/integration && node test-ml-options-ui.mjs
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EXTENSION_PATH = path.join(REPO_ROOT, "browser-extension");
const USER_DATA_DIR = path.join(__dirname, ".tmp-profile-ui");

function logStep(num, msg) { console.log(`\n[${num}] ${msg}`); }

async function main() {
  if (existsSync(USER_DATA_DIR)) rmSync(USER_DATA_DIR, { recursive: true, force: true });

  logStep("1/6", "Launching Chromium with extension");
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-default-browser-check",
      "--no-first-run",
    ],
  });
  let workers = context.serviceWorkers();
  if (workers.length === 0) {
    workers = [await context.waitForEvent("serviceworker", { timeout: 15000 })];
  }
  const sw = workers.find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("Extension SW not found");
  const extId = new URL(sw.url()).host;
  console.log(`   Extension ID: ${extId}`);

  sw.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      console.log(`   [sw] ${m.type()}: ${m.text()}`);
    }
  });

  logStep("2/6", "Opening options page");
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      console.log(`   [page] ${m.type()}: ${m.text()}`);
    }
  });
  page.on("pageerror", (err) => console.log(`   [page error] ${err.message}`));
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState("domcontentloaded");

  logStep("3/6", "Verifying ML card is present and toggle starts OFF");
  // The checkbox is visually hidden under a .switch label (custom slider
  // UI), so we wait for it to be attached, not visible, and click with
  // force:true / setChecked() to bypass Playwright's visibility check.
  await page.waitForSelector("#ml-enabled", { state: "attached", timeout: 5000 });
  const initialChecked = await page.locator("#ml-enabled").isChecked();
  if (initialChecked) throw new Error("ML toggle should start OFF on a fresh profile");
  const initialStatus = await page.locator("#ml-status").textContent();
  console.log(`   initial status: "${initialStatus}"`);
  if (!/未有効/.test(initialStatus)) {
    throw new Error(`expected initial status "未有効", got "${initialStatus}"`);
  }

  logStep("4/6", "Clicking the toggle ON (real user gesture)");
  // The .switch label wraps the hidden checkbox; clicking the label is
  // a real user gesture that fires the change event AND counts toward
  // chrome.permissions.request's gesture requirement. Scroll first
  // because the ML card lives below the fold on default viewport.
  await page.evaluate(() => document.getElementById("ml-enabled").scrollIntoView({ block: "center" }));
  await page.locator("label.switch").filter({ has: page.locator("#ml-enabled") }).click();
  // Status should flip to "ホスト権限を要求中…" then "モデルを取得中…"
  // and finally "✓ 準備完了". We wait for the success pill.
  console.log("   waiting for status to become '✓ 準備完了' (up to 120s)…");
  await page.waitForFunction(
    () => {
      const el = document.getElementById("ml-status");
      return !!(el && /準備完了/.test(el.textContent));
    },
    { timeout: 120_000 }
  );
  const okStatus = await page.locator("#ml-status").textContent();
  console.log(`   status: "${okStatus}"`);

  const stored = await page.evaluate(() => chrome.storage.local.get("mlEnabled"));
  console.log("   storage.mlEnabled:", stored.mlEnabled);
  if (stored.mlEnabled !== true) {
    throw new Error("expected mlEnabled=true after toggle ON");
  }

  logStep("5/6", "Toggling OFF should reset state");
  // The .switch label wraps the hidden checkbox; clicking the label is
  // a real user gesture that fires the change event AND counts toward
  // chrome.permissions.request's gesture requirement. Scroll first
  // because the ML card lives below the fold on default viewport.
  await page.evaluate(() => document.getElementById("ml-enabled").scrollIntoView({ block: "center" }));
  await page.locator("label.switch").filter({ has: page.locator("#ml-enabled") }).click();
  await page.waitForFunction(
    () => {
      const el = document.getElementById("ml-status");
      return !!(el && /未有効/.test(el.textContent));
    },
    { timeout: 5000 }
  );
  const offStored = await page.evaluate(() => chrome.storage.local.get("mlEnabled"));
  if (offStored.mlEnabled !== false) {
    throw new Error("expected mlEnabled=false after toggle OFF");
  }

  logStep("6/6", "Closing browser");
  await context.close();
  console.log("\n✅ PASS — ML options UI flow works end-to-end");
}

main().catch((err) => {
  console.error("\n❌ FAIL —", err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
