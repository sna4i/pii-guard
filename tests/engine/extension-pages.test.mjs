// tests/engine/extension-pages.test.mjs — 拡張機能のページに、コメントの切れ端や開発用の印が表示されない (P-UI-01、P-UI-02)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../browser-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
// 画面に出る文字: コメント・script・style・タグを除いたもの
const visibleText = (html) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ");

test("T-UI-01 拡張機能のページに、コメントの切れ端 (-->) が表示されない", () => {
  for (const f of ["popup.html", "options.html", "offscreen.html", "secure-composer/secure-composer.html"]) {
    assert.ok(!visibleText(read(f)).includes("-->"), f);
  }
});

test("T-UI-02 設定画面に、開発版の印 (dev) の付いた版の表示が無い", () => {
  assert.doesNotMatch(visibleText(read("options.html")), /v\d+\.\d+\.\d+\s*dev/i);
});
