// tests/engine/vendor-licenses.test.mjs — 同梱している部品のライセンスの告知 (docs/release-1.7.1.md の「同梱の部品のライセンス」)
//
// 拡張機能はストア用の zip に browser-extension を丸ごと入れる。同梱した部品の許諾の条件 (告知と本文を写しに含める) を、
// ファイルがそろっていることで確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../browser-extension");
const read = (p) => fs.readFileSync(path.join(EXT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(EXT, p));

test("T-LIC-01 告知のファイルが拡張機能の直下にあり、同梱した部品とそのライセンスの本文の場所を挙げる", () => {
  assert.ok(exists("THIRD_PARTY_NOTICES.txt"), "THIRD_PARTY_NOTICES.txt が無い");
  const n = read("THIRD_PARTY_NOTICES.txt");
  for (const s of ["Transformers.js", "Apache License 2.0", "vendor/transformers/LICENSE",
    "ONNX Runtime", "MIT License", "vendor/transformers/LICENSE-onnxruntime"]) {
    assert.ok(n.includes(s), `告知に「${s}」が無い`);
  }
});

test("T-LIC-02 告知が挙げたライセンスの本文が、同梱されている", () => {
  const apache = read("vendor/transformers/LICENSE");
  assert.match(apache, /Apache License\s+Version 2\.0, January 2004/);
  const mit = read("vendor/transformers/LICENSE-onnxruntime");
  assert.match(mit, /^MIT License/);
  assert.match(mit, /Copyright \(c\) Microsoft Corporation/);
  assert.match(mit, /The above copyright notice and this permission notice shall be included/);
});

test("T-LIC-03 告知が挙げた部品のファイルが、本当に同梱されている (告知と中身がずれない)", () => {
  for (const f of ["vendor/transformers/transformers.min.js", "vendor/transformers/ort-wasm-simd-threaded.jsep.mjs",
    "vendor/transformers/ort-wasm-simd-threaded.jsep.wasm"]) {
    assert.ok(exists(f), `${f} が無い`);
    assert.ok(read("THIRD_PARTY_NOTICES.txt").includes(path.basename(f)), `告知に ${path.basename(f)} が無い`);
  }
});
