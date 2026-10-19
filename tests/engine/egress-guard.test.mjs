// tests/engine/egress-guard.test.mjs — 送信・送信前の原文の持ち出しを伏せる/止める (F-EG-01〜04)
//
// 実サイトの本文は使わない (アカウントの情報が入る)。2026-10-18 に空送信で観測した構造をまねて組み立てる:
//   Claude  PerformAction : root{1:{1:"sess_..."}, 2:{1:uuid, 2:uuid, 3:<本文>, 7:{2:model}, 8:<設定>, 12:tz, 13:lang, 18:n}}
//   Gemini  processSession: count=1&ofs=1&req0___data__=<Base64( root{2:{1:1, 9:{1:<本文>}}} )>
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EG = require("../../browser-extension/security/egress-guard.js");

const te = new TextEncoder();
const td = new TextDecoder();
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const str = (num, s) => { const v = typeof s === "string" ? te.encode(s) : s; return cat(EG.encodeVarint(num * 8 + 2), EG.encodeVarint(v.length), v); };
const msg = (num, ...fields) => str(num, cat(...fields));
const vint = (num, n) => cat(EG.encodeVarint(num * 8), EG.encodeVarint(n));

const PHONE = "090-1234-5678";
const EMAIL = "taro.yamada@example.test";
const DRAFT = `PIIGUARDTEST 電話 ${PHONE} メール ${EMAIL}`;
const CONFIG = cat(...Array.from({ length: 30 }, (_, i) => str(1, `feature:flag:claude_web_${i}_enabled`)));

function claudeBody(text, { textField = 3 } = {}) {
  return cat(
    msg(1, str(1, "sess_00000000-0000-0000-0000-000000000000")),
    msg(2,
      str(1, "00000000-0000-0000-0000-000000000001"),
      str(2, "00000000-0000-0000-0000-000000000002"),
      str(textField, text),
      msg(7, str(2, "claude-test-model-1")),
      str(8, CONFIG),
      str(12, "Asia/Tokyo"),
      str(13, "ja"),
      vint(18, 1),
    ),
  );
}
function geminiForm(text) {
  const proto = msg(2, vint(1, 1), msg(9, str(1, text)));
  const b64 = Buffer.from(proto).toString("base64");
  return `count=1&ofs=1&req0___data__=${encodeURIComponent(b64)}`;
}
function sensitiveOf(...values) {
  const s = EG.createSensitiveSet();
  for (const [v, l] of values) s.add(v, l);
  return s;
}
const S = () => sensitiveOf([PHONE, "PHONE_NUMBER"], [EMAIL, "EMAIL_ADDRESS"]);
const has = (u8, s) => td.decode(u8).includes(s);

// ---- T-EG-01 protobuf ----------------------------------------------------------
test("T-EG-01a 書き換え無しなら同じバイト列のまま", () => {
  const b = claudeBody(DRAFT);
  const r = EG.rewriteProto(b, { mayContain: () => false, rewrite: (t) => t });
  assert.equal(r.changed, false);
  assert.deepEqual(r.bytes, b);
});

test("T-EG-01b 入れ子の文字列を差し替えると長さが直り、他のフィールドはバイト単位で同じ", () => {
  const b = claudeBody(DRAFT);
  const out = EG.setAtPath(b, [2, 3], te.encode("短い"));
  assert.equal(td.decode(EG.getAtPath(out, [2, 3])), "短い");
  assert.deepEqual(EG.getAtPath(out, [1]), EG.getAtPath(b, [1]));
  assert.deepEqual(EG.getAtPath(out, [2, 8]), EG.getAtPath(b, [2, 8]));
  assert.equal(td.decode(EG.getAtPath(out, [2, 12])), "Asia/Tokyo");
  const longer = EG.setAtPath(b, [2, 3], te.encode("あ".repeat(300))); // 長さの varint が 2 バイトに増える
  assert.equal(td.decode(EG.getAtPath(longer, [2, 3])), "あ".repeat(300));
  assert.ok(EG.parseMessage(longer));
});

test("T-EG-01c 値を含む入れ子の文字列だけを伏せ字にし、protobuf として読める", () => {
  const s = S();
  const r = EG.rewriteProto(claudeBody(DRAFT), { mayContain: (v) => s.mayContainBytes(v), rewrite: (t) => s.scrubText(t) });
  assert.ok(r.changed && !r.stuck);
  const text = td.decode(EG.getAtPath(r.bytes, [2, 3]));
  assert.ok(!text.includes(PHONE) && !text.includes(EMAIL));
  assert.match(text, /<PHONE_NUMBER_\d+>/);
  assert.match(text, /PIIGUARDTEST/);
  assert.equal(td.decode(EG.getAtPath(r.bytes, [2, 7, 2])), "claude-test-model-1");
});

test("T-EG-01d 文字列に見える入れ子 (0a 4e + 本文) でも、中の文字列の長さを正しく直す", () => {
  const proto = msg(2, vint(1, 1), msg(9, str(1, DRAFT))); // root.2.9 は「改行 + 'N' + 本文」とも読める
  const s = S();
  const r = EG.rewriteProto(proto, { mayContain: (v) => s.mayContainBytes(v), rewrite: (t) => s.scrubText(t) });
  assert.ok(r.changed && !r.stuck);
  const inner = td.decode(EG.getAtPath(r.bytes, [2, 9, 1]));
  assert.ok(!inner.includes(PHONE));
  assert.match(inner, /PIIGUARDTEST 電話 <PHONE_NUMBER_\d+>/);
});

test("T-EG-01e protobuf としても読めてしまう短い文字列 (電話番号だけ) も伏せる", () => {
  assert.ok(EG.parseMessage(te.encode(PHONE)), "前提: 電話番号だけの文字列は protobuf としても読める");
  const s = S();
  const r = EG.rewriteProto(claudeBody(PHONE), { mayContain: (v) => s.mayContainBytes(v), rewrite: (t) => s.scrubText(t) });
  assert.ok(r.changed);
  assert.match(td.decode(EG.getAtPath(r.bytes, [2, 3])), /^<PHONE_NUMBER_\d+>$/);
});

// ---- T-EG-02 WebChannel ---------------------------------------------------------
test("T-EG-02a WebChannel のフォームを分解・組み立てて元に戻る", () => {
  const f = geminiForm(DRAFT);
  const m = EG.parseWebChannelForm(f);
  assert.equal(m.items.length, 1);
  assert.equal(EG.buildWebChannelForm(m), f);
  assert.match(td.decode(EG.getAtPath(m.items[0].bytes, [2, 9, 1])), /PIIGUARDTEST/);
});

test("T-EG-02b WebChannel の中の protobuf の値を伏せ字にできる", () => {
  const m = EG.parseWebChannelForm(geminiForm(DRAFT));
  const r = EG.scrubWebChannel(m, S());
  assert.ok(r.changed && !r.stuck);
  const back = EG.parseWebChannelForm(EG.buildWebChannelForm(m));
  const inner = td.decode(EG.getAtPath(back.items[0].bytes, [2, 9, 1]));
  assert.ok(!inner.includes(PHONE) && !inner.includes(EMAIL));
});

// ---- T-EG-03 decide -------------------------------------------------------------
const ctxFor = (pageHost, drafts = [DRAFT]) => ({ sensitive: S(), drafts, firstParty: EG.firstPartyFor(pageHost) });

test("T-EG-03a サイト自身宛ての JSON に生の値があれば伏せ字にして通す", () => {
  const body = JSON.stringify({ title: `メモ ${PHONE}`, x: 1 });
  const r = EG.decide({ url: "https://claude.ai/api/x", host: "claude.ai", text: body }, ctxFor("claude.ai"));
  assert.equal(r.action, "scrub");
  assert.ok(!r.text.includes(PHONE));
  assert.doesNotThrow(() => JSON.parse(r.text));
});

test("T-EG-03b 外部宛て (解析ツール) に値があれば止める", () => {
  const body = JSON.stringify({ events: [{ event_type: "[Amplitude] Element Clicked", event_properties: { "[Amplitude] Element Text": `x ${PHONE}` } }] });
  const r = EG.decide({ url: "https://api2.amplitude.com/2/httpapi", host: "api2.amplitude.com", text: body }, ctxFor("manus.im"));
  assert.equal(r.action, "block");
});

test("T-EG-03c 外部宛てに下書きの一部 (個人情報でなくても) が出たら止める", () => {
  const draft = "来週の役員会で発表する新製品の価格は据え置きにする方針です";
  const body = JSON.stringify({ e: [{ text: "新製品の価格は据え置きにする方針" }] });
  const r = EG.decide({ url: "https://api2.amplitude.com/2/httpapi", host: "api2.amplitude.com", text: body }, ctxFor("manus.im", [draft]));
  assert.equal(r.action, "block");
  assert.equal(r.reason, "body-echoes-draft");
});

test("T-EG-03d サイト自身宛てで個人情報が無ければ、下書きの一部があっても通す", () => {
  const draft = "来週の役員会で発表する新製品の価格は据え置きにする方針です";
  const r = EG.decide({ url: "https://claude.ai/api/title", host: "claude.ai", text: JSON.stringify({ t: draft }) }, ctxFor("claude.ai", [draft]));
  assert.equal(r.action, "pass");
});

test("T-EG-03e 置き換えられない形 (Base64) に値があれば止める", () => {
  const b64 = Buffer.from(`hello ${PHONE} world`).toString("base64");
  const r = EG.decide({ url: "https://claude.ai/api/x", host: "claude.ai", text: JSON.stringify({ blob: b64 }) }, ctxFor("claude.ai"));
  assert.equal(r.action, "block");
});

test("T-EG-03f URL に値があれば止める", () => {
  const r = EG.decide({ url: `https://claude.ai/api/search?q=${encodeURIComponent(PHONE)}`, host: "claude.ai", text: "" }, ctxFor("claude.ai"));
  assert.equal(r.action, "block");
});

test("T-EG-03g サイト自身宛ての protobuf に値があれば、protobuf のまま伏せ字にする", () => {
  const r = EG.decide({ url: "https://claude.ai/claudeai-rpc/x.Y/Z", host: "claude.ai", bytes: claudeBody(DRAFT) }, ctxFor("claude.ai"));
  assert.equal(r.action, "scrub");
  assert.ok(!has(r.bytes, PHONE) && !has(r.bytes, EMAIL));
  assert.ok(EG.parseMessage(r.bytes));
});

test("T-EG-03h WebChannel の中に値があれば (アダプタが拾えなかったとき) 伏せ字にする", () => {
  const r = EG.decide({ url: "https://x.clients6.google.com/v1/other", host: "x.clients6.google.com", text: geminiForm(DRAFT) }, ctxFor("gemini.google.com"));
  assert.equal(r.action, "scrub");
  const m = EG.parseWebChannelForm(r.text);
  assert.ok(!td.decode(m.items[0].bytes).includes(PHONE));
});

test("T-EG-03i 関係ない通信は通す。中身を読めない外部宛ては、守る原文があるときだけ止める", () => {
  assert.equal(EG.decide({ url: "https://claude.ai/api/x", host: "claude.ai", text: '{"a":1}' }, ctxFor("claude.ai")).action, "pass");
  assert.equal(EG.decide({ url: "https://api2.amplitude.com/2/httpapi", host: "api2.amplitude.com", unreadable: true }, ctxFor("manus.im")).action, "block");
  assert.equal(EG.decide({ url: "https://api2.amplitude.com/2/httpapi", host: "api2.amplitude.com", unreadable: true }, { sensitive: EG.createSensitiveSet(), drafts: [], firstParty: EG.firstPartyFor("manus.im") }).action, "pass");
  assert.equal(EG.decide({ url: "https://claude.ai/api/x", host: "claude.ai", unreadable: true }, ctxFor("claude.ai")).action, "pass");
});

test("T-EG-03j 全角・URL エンコード・JSON の \\u エスケープの形でも見つけて伏せる", () => {
  const s = sensitiveOf(["山田太郎", "PERSON"], [PHONE, "PHONE_NUMBER"]);
  const ctx = { sensitive: s, drafts: [], firstParty: EG.firstPartyFor("claude.ai") };
  const full = PHONE.replace(/[0-9-]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  for (const body of [`{"t":"${full}"}`, `q=${encodeURIComponent("山田太郎")}`, JSON.stringify({ t: "山田太郎" }).replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))]) {
    const r = EG.decide({ url: "https://claude.ai/api/x", host: "claude.ai", text: body }, ctx);
    assert.equal(r.action, "scrub", body);
    assert.equal(s.findIn(r.text).length, 0, body);
  }
});

// ---- T-EG-04 送信アダプタ ----------------------------------------------------------
test("T-EG-04a Claude: 本文を取り出し、マスク済みに差し替えて組み直せる", () => {
  const a = EG.adapters.claudeRpc;
  assert.ok(a.match("https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction"));
  assert.ok(!a.match("https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ListThings"));
  const b = claudeBody(DRAFT);
  const m = a.decode(b, []);
  assert.deepEqual(a.extractInputs(m), [DRAFT]);
  const masked = DRAFT.replace(PHONE, "<PHONE_NUMBER_1>").replace(EMAIL, "<EMAIL_ADDRESS_1>");
  const out = a.encode(a.replaceInputs(m, [masked]));
  assert.equal(td.decode(EG.getAtPath(out, [2, 3])), masked);
  assert.deepEqual(EG.getAtPath(out, [2, 8]), EG.getAtPath(b, [2, 8]));
});

test("T-EG-04b Claude: 本文の場所が変わっても、下書きと同じ中身のフィールドを見つける", () => {
  const a = EG.adapters.claudeRpc;
  const b = claudeBody(DRAFT, { textField: 5 });
  assert.deepEqual(a.extractInputs(a.decode(b, [])), [], "決まった道筋には無い");
  const m = a.decode(b, [DRAFT]);
  assert.deepEqual(a.extractInputs(m), [DRAFT]);
  const out = a.encode(a.replaceInputs(m, ["伏せ字"]));
  assert.equal(td.decode(EG.getAtPath(out, [2, 5])), "伏せ字");
});

test("T-EG-04c Gemini: WebChannel の本文を取り出し、差し替えて組み直せる", () => {
  const a = EG.adapters.geminiSession;
  assert.ok(a.match("https://geminiweb-pa.clients6.google.com/v1/processSession?VER=8&RID=1"));
  const m = a.decode(geminiForm(DRAFT), []);
  assert.deepEqual(a.extractInputs(m), [DRAFT]);
  const out = a.encode(a.replaceInputs(m, ["マスク済み <PHONE_NUMBER_1>"]));
  const back = EG.parseWebChannelForm(out);
  assert.equal(td.decode(EG.getAtPath(back.items[0].bytes, [2, 9, 1])), "マスク済み <PHONE_NUMBER_1>");
  assert.match(out, /^count=1&ofs=1&req0___data__=/);
});

test("T-EG-04d Claude: 添付 (root.2.15 の繰り返し) の中身とファイル名を 1 件ずつ取り出して差し替えられる", () => {
  const a = EG.adapters.claudeRpc;
  const att = (name, content) => msg(15, str(1, name), vint(2, content.length), str(3, "text/plain"), str(4, content));
  const body = cat(
    msg(1, str(1, "sess_x")),
    msg(2, str(1, "uuid-1"), str(3, DRAFT), att("山田太郎_履歴書.txt", `氏名 山田太郎\n電話 ${PHONE}`), att("memo.txt", `メール ${EMAIL}`), str(12, "Asia/Tokyo")),
  );
  const m = a.decode(body, []);
  const fields = a.autoFields(m);
  assert.deepEqual(fields.map((f) => [f.kind, f.text]), [
    ["content", `氏名 山田太郎\n電話 ${PHONE}`], ["name", "山田太郎_履歴書.txt"],
    ["content", `メール ${EMAIL}`], ["name", "memo.txt"],
  ]);
  let m2 = a.setField(m, fields[2].path, "メール <EMAIL_ADDRESS_1>");
  m2 = a.setField(m2, fields[1].path, "[PERSON_1]_履歴書.txt");
  const out = a.encode(m2);
  assert.equal(td.decode(EG.getAtPath(out, [2, { n: 15, k: 1 }, 4])), "メール <EMAIL_ADDRESS_1>");
  assert.equal(td.decode(EG.getAtPath(out, [2, { n: 15, k: 0 }, 1])), "[PERSON_1]_履歴書.txt");
  assert.equal(td.decode(EG.getAtPath(out, [2, { n: 15, k: 0 }, 4])), `氏名 山田太郎\n電話 ${PHONE}`, "触っていない添付はそのまま");
  assert.equal(td.decode(EG.getAtPath(out, [2, 3])), DRAFT);
  assert.equal(td.decode(EG.getAtPath(out, [2, 12])), "Asia/Tokyo");
});
