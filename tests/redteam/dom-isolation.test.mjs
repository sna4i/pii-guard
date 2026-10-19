// tests/redteam/dom-isolation.test.mjs — ページ JS から Secure Composer の原文を取れない (P0-04)
//
// RT-DOM-01  ページ MAIN world から、重ねられた拡張オリジンの iframe の contentDocument /
//            contentWindow の中身 (原文・textarea の値) を読めない。src 属性以外は触れない。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, sleep, writeEvidence } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

test("RT-DOM-01 ページから iframe の原文を読めない (P0-04)", async () => {
  const canary = makeCanary("DOM");
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await h.type(page, frame, canary + " これは下書き");
  await sleep(500);
  // ページの MAIN world から、拡張 iframe の中を読もうとする
  const probe = await page.evaluate((needle) => {
    const out = { iframes: 0, srcLeaksExtOrigin: false, docAccessible: false, textReadable: false, errors: [] };
    const ifr = [...document.querySelectorAll("iframe")];
    out.iframes = ifr.length;
    for (const f of ifr) {
      const src = f.getAttribute("src") || "";
      if (src.startsWith("chrome-extension://")) out.srcLeaksExtOrigin = true; // src は見える (ペナルティではない)
      try {
        const doc = f.contentDocument;
        if (doc) { out.docAccessible = true; const t = doc.body ? doc.body.innerText : ""; if (t && t.includes(needle)) out.textReadable = true; }
      } catch (e) { out.errors.push("contentDocument:" + e.name); }
      try {
        const w = f.contentWindow;
        // 同一オリジンでなければ document へのアクセスは throw する
        const t = w && w.document && w.document.querySelector("textarea");
        if (t && String(t.value).includes(needle)) out.textReadable = true;
      } catch (e) { out.errors.push("contentWindow:" + e.name); }
    }
    // window.frames からも試す
    for (let i = 0; i < window.frames.length; i++) {
      try { const d = window.frames[i].document; if (d && d.body && d.body.innerText.includes(needle)) out.textReadable = true; }
      catch (e) { out.errors.push("frames[" + i + "]:" + e.name); }
    }
    return out;
  }, canary);
  writeEvidence("rt-dom-01", probe);
  await page.close();
  assert.equal(probe.textReadable, false, "ページから iframe 内の原文が読めた (P0-04)");
  assert.equal(probe.docAccessible, false, "ページから iframe の contentDocument が読めた");
});
