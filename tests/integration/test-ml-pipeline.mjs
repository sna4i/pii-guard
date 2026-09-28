// test-ml-pipeline.mjs — end-to-end smoke test for the in-browser ML
// detector wired up in browser-extension/.
//
// Verifies:
//   1. The unpacked extension loads cleanly (no manifest / SW errors).
//   2. The MV3 service worker registers and is reachable.
//   3. ML_PREWARM creates an offscreen document, transformers.js loads,
//      and the model finishes downloading from HF Hub.
//   4. ML_DETECT returns aggregated NER spans for a Japanese PII sample
//      ("田中太郎は東京の株式会社アスタリスクに勤めています。") that
//      includes at minimum a PROPER_NOUN_PERSON ("田中太郎") and a
//      PROPER_NOUN_LOCATION ("東京") — the latter is the strongest
//      signal that ML is alive, since the regex/dictionary layer never
//      flags "東京" on its own.
//
// Usage:
//   cd tests/integration && npm install && npx playwright install chromium
//   node test-ml-pipeline.mjs
//
// Exit code is 0 on PASS, 1 on FAIL.

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EXTENSION_PATH = path.join(REPO_ROOT, "browser-extension");
const USER_DATA_DIR = path.join(__dirname, ".tmp-profile");

// Sample text — keep it short; the model max_length is 512 tokens.
const SAMPLE_TEXT =
  "田中太郎は東京の株式会社アスタリスクに勤めています。";

// Hard floor for what the test demands. Must include 田中太郎 (PERSON)
// and 東京 (LOCATION). MISC labels are dropped by onnx-detector.js so
// we don't expect them.
const REQUIRED_HITS = [
  { entity_type: "PROPER_NOUN_PERSON", text: "田中太郎" },
  { entity_type: "PROPER_NOUN_LOCATION", text: "東京" },
];

function logStep(num, msg) {
  console.log(`\n[${num}] ${msg}`);
}

async function main() {
  // Ensure fresh profile so prior runs don't affect this.
  if (existsSync(USER_DATA_DIR)) rmSync(USER_DATA_DIR, { recursive: true, force: true });

  logStep("1/6", "Launching Chromium with extension loaded");
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,                 // extensions need a real display
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-default-browser-check",
      "--no-first-run",
    ],
  });

  // Find the extension's service worker URL → derive extension ID.
  let workers = context.serviceWorkers();
  if (workers.length === 0) {
    workers = [await context.waitForEvent("serviceworker", { timeout: 15000 })];
  }
  const sw = workers.find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("Extension service worker not found");
  const extId = new URL(sw.url()).host;
  console.log(`   Extension ID: ${extId}`);

  // Surface SW console output so any error inside background.js shows up
  // in the test output (otherwise we'd only see the test asserts fail
  // with no context).
  sw.on("console", (m) => console.log(`   [sw] ${m.type()}: ${m.text()}`));

  logStep("2/6", "Opening extension options page");
  const page = await context.newPage();
  page.on("console", (m) => console.log(`   [page] ${m.type()}: ${m.text()}`));
  page.on("pageerror", (err) => console.log(`   [page error] ${err.message}`));
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState("domcontentloaded");

  logStep("3/6", "Setting mlEnabled=true via chrome.storage.local");
  await page.evaluate(async () => {
    await chrome.storage.local.set({ mlEnabled: true });
  });

  logStep("4/6", "Sending ML_PREWARM (model download + WASM init, ~30-90s)");
  const prewarmStart = Date.now();
  const prewarm = await page.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "ML_PREWARM" }, (resp) => resolve(resp));
      })
  );
  const prewarmMs = Date.now() - prewarmStart;
  console.log("   prewarm response:", JSON.stringify(prewarm));
  console.log(`   prewarm took ${(prewarmMs / 1000).toFixed(1)}s`);
  if (!prewarm || prewarm.ok !== true) {
    throw new Error(
      "ML_PREWARM failed: " + (prewarm && prewarm.error) || "no response"
    );
  }

  logStep("5/6", "Sending ML_DETECT for sample text");
  console.log(`   text: ${SAMPLE_TEXT}`);
  const detect = await page.evaluate(
    (text) =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "ML_DETECT", text }, (resp) =>
          resolve(resp)
        );
      }),
    SAMPLE_TEXT
  );
  console.log("   detect response:", JSON.stringify(detect));
  if (!detect || detect.ok !== true || !Array.isArray(detect.entities)) {
    throw new Error("ML_DETECT returned invalid shape");
  }

  logStep("6/6", "Verifying required hits in detection output");
  const hits = detect.entities.map(
    (e) =>
      `${(e.entity_group || "").toString()}:${SAMPLE_TEXT.slice(e.start, e.end)}`
  );
  console.log("   raw entities (entity_group : text):");
  for (const h of hits) console.log(`     ${h}`);

  const missing = [];
  for (const need of REQUIRED_HITS) {
    const wantGroup =
      need.entity_type === "PROPER_NOUN_PERSON"
        ? "PER"
        : need.entity_type === "PROPER_NOUN_LOCATION"
        ? "LOC"
        : need.entity_type === "PROPER_NOUN_ORG"
        ? "ORG"
        : null;
    const found = detect.entities.some(
      (e) =>
        (e.entity_group || "").toUpperCase() === wantGroup &&
        SAMPLE_TEXT.slice(e.start, e.end).includes(need.text)
    );
    if (!found) missing.push(`${need.entity_type} "${need.text}"`);
  }

  await context.close();

  if (missing.length > 0) {
    console.error("\n❌ FAIL — missing required detections:");
    for (const m of missing) console.error(`   - ${m}`);
    process.exit(1);
  }
  console.log("\n✅ PASS — ML pipeline (offscreen → transformers.js → model) end-to-end OK");
}

main().catch((err) => {
  console.error("\n❌ FAIL —", err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
