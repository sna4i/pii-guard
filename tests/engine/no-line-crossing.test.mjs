// tests/engine/no-line-crossing.test.mjs — どの検出 span も改行をまたがない。
//
// v1.4.1 で、ラベル付き ID の区切りを「改行以外の空白」にするつもりで
// 正規表現リテラルに [^\\S\\n] と書いてしまった。リテラルの中では
// バックスラッシュを二重にしないので、これは「\ と S と n 以外の任意の
// 文字」になり、改行を含むほぼ全てに一致する。結果、
//   社員番号：EMP-458721
//   運転免許証番号：第123456789012号
//   マイナンバー相当テスト番号：1234-5678-9012
//   …
// の 5 行が 1 つの <EMPLOYEE_ID_1> に飲み込まれ、送信文から消えた。
// 1 行・短文のベクタでは span の終端が偶然一致して検出できなかった。
//
// 個別のパターンを直すだけでなく、「span は行をまたがない」を複数行の
// 実データで常に検査する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("../../browser-extension/engine/engine.js");

// 本当に複数行にまたがる実体は PEM 秘密鍵だけ。ラベルではなく中身で判定する
// — SECRET には .env の行も含まれ、そちらが改行を食うのはバグなので。
const isMultilineOk = (d) => d.entity_type === "SECRET" && d.text.startsWith("-----BEGIN");

const RECORD = [
  "顧客番号：TEST-CUST-20260922-001",
  "氏名：山田 太郎",
  "社員番号：EMP-458721",
  "運転免許証番号：第123456789012号",
  "マイナンバー相当テスト番号：1234-5678-9012",
  "契約番号 C-2026-0042",
  "会員番号は M-7788",
  "請求書番号：INV-20260901",
  "発注番号：PO-445566",
  "顧客ID：C-00045872",
  "最終ログインIP：192.0.2.145",
  "部署コード：D-1024",
  "患者番号：P-99887",
  "商品コード：SKU-A1B2",
  "資産番号：AST-5566",
  "From: tanaka@example.co.jp",
  "To: sato@example.co.jp",
  "Cookie: session_id=abcdef123456",
  "export STRIPE_SECRET_KEY=dummy-value-not-a-real-key",
  "2026-09-22 18:15:32 INFO Customer profile accessed",
].join("\n");

test("no detection span crosses a line break", async () => {
  const san = await engine.maskSanitize(RECORD, {});
  const crossing = san.detections
    .filter((d) => d.text.includes("\n") && !isMultilineOk(d))
    .map((d) => `${d.entity_type} (${d.text.length} chars): ${JSON.stringify(d.text.slice(0, 60))}`);
  assert.deepEqual(crossing, [], `spans crossing a newline:\n  ${crossing.join("\n  ")}`);
});

test("masking keeps every line of the input", async () => {
  // span が改行を食うと、行そのものが送信文から消える。
  const san = await engine.maskSanitize(RECORD, {});
  const inLines = RECORD.split("\n").length;
  const outLines = san.sanitized_text.split("\n").length;
  assert.equal(outLines, inLines, `lines lost: ${inLines} -> ${outLines}\n${san.sanitized_text}`);
});
