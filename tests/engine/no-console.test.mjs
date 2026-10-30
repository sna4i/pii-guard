// tests/engine/no-console.test.mjs — 拡張機能はブラウザのコンソールに何も書かない (docs/diagnostic-log.md の R-LG-01、T-LG-05)
//
// browser-extension/ の JavaScript (同梱のライブラリ vendor/ を除く) に console.* の呼び出しが無いこと。
// ログは diag-log.js の動作ログに残し、設定画面の「ログ」タブで見る。
// Run: node --test tests/engine/no-console.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../browser-extension");

function* jsFiles(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== "vendor" && ent.name !== "node_modules") yield* jsFiles(p); }
    else if (/\.(m?js)$/.test(ent.name)) yield p;
  }
}

test("T-LG-05 no console calls outside vendor/", () => {
  const hits = [];
  for (const f of jsFiles(ROOT)) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      // コメントの中の言及は除く (行頭が // か *)
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/\bconsole\s*\.\s*(log|debug|info|warn|error|trace|table|dir|group|time|assert|count)\b/.test(line)) {
        hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(hits, [], "console.* が残っている");
});

test("T-LG-05b the log module is loaded wherever the extension runs code", () => {
  for (const name of ["manifest.json", "manifest.store.json"]) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
    const isolated = m.content_scripts.find((cs) => (cs.world || "ISOLATED") === "ISOLATED" && cs.js.includes("content.js"));
    assert.equal(isolated.js[0], "diag-log.js", `${name}: content script の最初に読む (エンジンの読み込み失敗も残せるように)`);
    const war = (m.web_accessible_resources || []).flatMap((w) => w.resources);
    assert.ok(!war.includes("diag-log.js"), `${name}: ページからは読めない`);
  }
  for (const page of ["options.html", "popup.html", "offscreen.html", "secure-composer/secure-composer.html"]) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    assert.match(html, /<script src="(\.\.\/)?diag-log\.js"><\/script>/, `${page} が diag-log.js を読む`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), /^import "\.\/diag-log\.js";$/m, "Service Worker が diag-log.js を読む");
});
