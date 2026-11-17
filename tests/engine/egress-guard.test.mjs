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

// ---- T-EG-09 利用者が決めた本文の欄の親を、文字列として書き換えない (P-EG-02) ----------------
const KEPT = `連絡先は ${PHONE} と <EMAIL_ADDRESS_1> です`; // 確認で電話番号を外した本文

test("T-EG-09a Gemini: 本文に残した値が検出済みでも、本文を変えず、内側の長さも壊さない", () => {
  const m = EG.adapters.geminiSession.decode(geminiForm(KEPT), [KEPT]);
  const r = EG.adapters.geminiSession.scrubOthers(m, S());
  assert.equal(r.stuck, false);
  const wc = EG.parseWebChannelForm(EG.adapters.geminiSession.encode(r.model));
  const v = EG.getAtPath(wc.items[0].bytes, [2, 9, 1]);
  assert.ok(v, "本文の欄が protobuf として読める");
  assert.equal(td.decode(v), KEPT);
});

test("T-EG-09b Claude: 本文に残した値が検出済みでも、送信を止めず、本文を変えない", () => {
  const m = EG.adapters.claudeRpc.decode(claudeBody(KEPT), [KEPT]);
  const r = EG.adapters.claudeRpc.scrubOthers(m, S());
  assert.equal(r.stuck, false);
  assert.equal(td.decode(EG.getAtPath(EG.adapters.claudeRpc.encode(r.model), [2, 3])), KEPT);
});

test("T-EG-09c 本文と同じ親の別の欄に残った値は伏せ、本文は変えない", () => {
  const body = cat(msg(1, str(1, "sess_x")), msg(2, str(3, KEPT), str(20, `件名 ${PHONE}`)));
  const m = EG.adapters.claudeRpc.decode(body, [KEPT]);
  const r = EG.adapters.claudeRpc.scrubOthers(m, S());
  assert.equal(r.stuck, false);
  const out = EG.adapters.claudeRpc.encode(r.model);
  assert.equal(td.decode(EG.getAtPath(out, [2, 3])), KEPT);
  assert.match(td.decode(EG.getAtPath(out, [2, 20])), /<PHONE_NUMBER_\d+>/);
});

// 決まった道筋 (Claude 2.3、Gemini 2.9.1) は番号だけで、繰り返しの何番目かを区別しない (差し替えは最初の出現に書き、飛ばす判定は番号で比べる)。
// 本文の欄と同じ番号の別の出現も飛ばされるので、伏せたあと本文の欄の外に値が残っていたら止める (D-EG-09)
const MASKED = "連絡先は <PHONE_NUMBER_1> と <EMAIL_ADDRESS_1> です"; // ふつうに全部伏せた本文

test("T-EG-09d 本文の道筋が繰り返され、本文でない方の出現に検出済みの値が残っていたら、送信を止める (Claude、Gemini)", () => {
  const other = `電話 ${PHONE}`;
  const sess = msg(1, str(1, "sess_x"));
  for (const [shape, body] of [
    ["Claude: root.2 の中で 2.3 が繰り返す", cat(sess, msg(2, str(3, MASKED), str(3, other)))],
    ["Claude: root.2 が繰り返す", cat(sess, msg(2, str(3, MASKED)), msg(2, str(3, other)))],
  ]) {
    const m = EG.adapters.claudeRpc.decode(body, []);
    assert.deepEqual(EG.adapters.claudeRpc.extractInputs(m), [MASKED], `${shape}: 前提: 本文は最初の出現`);
    assert.equal(EG.adapters.claudeRpc.scrubOthers(m, S()).stuck, true, `${shape}: 送信を止める`);
  }
  for (const [shape, proto] of [
    ["Gemini: root.2.9 の中で 2.9.1 が繰り返す", msg(2, vint(1, 1), msg(9, str(1, MASKED), str(1, other)))],
    ["Gemini: root.2.9 が繰り返す", msg(2, vint(1, 1), msg(9, str(1, MASKED)), msg(9, str(1, other)))],
  ]) {
    const m = EG.adapters.geminiSession.decode(`count=1&ofs=1&req0___data__=${encodeURIComponent(Buffer.from(proto).toString("base64"))}`, []);
    assert.deepEqual(EG.adapters.geminiSession.extractInputs(m), [MASKED], `${shape}: 前提: 本文は最初の出現`);
    assert.equal(EG.adapters.geminiSession.scrubOthers(m, S()).stuck, true, `${shape}: 送信を止める`);
  }
});

test("T-EG-09e Claude: 形が変わり、下書きと同じ中身で見つけた本文の欄が繰り返しの 2 つ目にあっても、原文のまま送らない。伏せた本文は 2 つ目の出現に書き、1 つ目は書き換えない", () => {
  const a = EG.adapters.claudeRpc;
  const raw = `連絡先は ${PHONE} と ${EMAIL} です`;
  const body = cat(msg(1, str(1, "sess_x")), msg(5, str(1, "前の話題")), msg(5, str(1, raw)));
  const m0 = a.decode(body, [raw]);
  assert.deepEqual(m0.fields.map((f) => f.path), [[{ n: 5, k: 1 }, { n: 1, k: 0 }]], "前提: 決まった道筋 (2.3) が無く、下書きと同じ中身の欄を、root.5 の 2 つ目の出現の 1 に見つける");
  const r = a.scrubOthers(a.replaceInputs(m0, [MASKED]), S());
  const out = a.encode(r.model);
  assert.ok(r.stuck || (!has(out, PHONE) && !has(out, EMAIL)), `原文のまま送らない (stuck=${r.stuck})`);
  assert.equal(r.stuck, false, "1 つ目の出現 (前の話題) に検出済みの値は無いので、送信を止めない");
  assert.equal(td.decode(EG.getAtPath(out, [{ n: 5, k: 1 }, 1])), MASKED, "伏せた本文は、利用者が決めた 2 つ目の出現に書く");
  assert.equal(td.decode(EG.getAtPath(out, [{ n: 5, k: 0 }, 1])), "前の話題", "1 つ目の出現 (関係のない欄) を書き換えない");
});

// ---- 救済の道でも、確認に出ていない出現の値を原文のまま送らない (C-1) ----------------------------------
// 決まった道筋 (Claude 2.3、Gemini 2.9.1) が無いと、下書きと同じ中身の欄を本文として探す (救済の道)。
// 下書きの欄が繰り返しの 2 つ目にある形を、Claude は root.5、Gemini は root.2.7 の繰り返しで作る
const formOf = (proto) => `count=1&ofs=1&req0___data__=${encodeURIComponent(Buffer.from(proto).toString("base64"))}`;
const RESCUE = [
  {
    shape: "Claude (root.5 の繰り返し)",
    a: EG.adapters.claudeRpc,
    make: (first, second) => cat(msg(1, str(1, "sess_x")), msg(5, str(1, first)), msg(5, str(1, second))),
    bytesOf: (sent) => sent,
    nth: (k) => [{ n: 5, k }, 1],
  },
  {
    shape: "Gemini (root.2.7 の繰り返し)",
    a: EG.adapters.geminiSession,
    make: (first, second) => formOf(msg(2, vint(1, 1), msg(7, str(1, first)), msg(7, str(1, second)))),
    bytesOf: (sent) => EG.parseWebChannelForm(sent).items[0].bytes,
    nth: (k) => [2, { n: 7, k }, 1],
  },
];

test("T-EG-09f 救済の道で、下書きの欄が繰り返しの 2 つ目にあっても、1 つ目の出現 (確認に出ていない欄) の検出済みの値を原文のまま送らない (Claude、Gemini)", () => {
  const draft = "来週の会議の議題をまとめてください"; // 個人情報の無い下書き (確認は出ない)
  for (const { shape, a, make, bytesOf } of RESCUE) {
    const req = make(`前回の連絡先 ${PHONE} (古い話題)`, draft);
    assert.deepEqual(a.extractInputs(a.decode(req, [])), [], `${shape}: 前提: 決まった道筋には無い`);
    const m = a.decode(req, [draft]);
    assert.deepEqual(a.extractInputs(m), [draft], `${shape}: 前提: 下書きと同じ中身の欄 (2 つ目の出現) を見つける`);
    const r = a.scrubOthers(m, S());
    assert.ok(r.stuck || !has(bytesOf(a.encode(r.model)), PHONE), `${shape}: 原文のまま送らない (stuck=${r.stuck})`);
  }
});

test("T-EG-09g 救済の道で、下書きの欄が繰り返しの 2 つ目にあり、利用者が値を全部本文に残したら、決めたとおりに送る (Claude、Gemini)", () => {
  const raw = `連絡先は ${PHONE} と ${EMAIL} です`;
  for (const { shape, a, make, bytesOf, nth } of RESCUE) {
    const m = a.decode(make("前の話題", raw), [raw]);
    assert.deepEqual(a.extractInputs(m), [raw], `${shape}: 前提: 下書きと同じ中身の欄 (2 つ目の出現) を見つける`);
    // 値を全部残したので、本文は書き換えない (injected.js と同じく replaceInputs を呼ばない)
    const r = a.scrubOthers(m, S());
    assert.equal(r.stuck, false, `${shape}: 送信を止めない`);
    const out = bytesOf(a.encode(r.model));
    assert.equal(td.decode(EG.getAtPath(out, nth(1))), raw, `${shape}: 決めた本文 (2 つ目の出現) を変えない`);
    assert.equal(td.decode(EG.getAtPath(out, nth(0))), "前の話題", `${shape}: 1 つ目の出現を変えない`);
  }
});

test("T-EG-09h Gemini: 本文が 128 バイト以上 (内側の長さが 2 バイト) で、本文に残した値が検出済みでも、送信を止めず、決めた本文と内側の長さを壊さない", () => {
  const a = EG.adapters.geminiSession;
  const tail = "。来週の打ち合わせの日程を調整したいので、候補の日を三つ挙げてください";
  const raw = `連絡先は ${PHONE} と ${EMAIL} です${tail}`;
  const decided = `${KEPT}${tail}`; // 確認で電話番号を外し、メールだけ伏せた本文
  assert.ok(te.encode(decided).length >= 128, "前提: 決めた本文は 128 バイト以上 (長さの varint が 2 バイト)");
  const r = a.scrubOthers(a.replaceInputs(a.decode(geminiForm(raw), []), [decided]), S());
  assert.equal(r.stuck, false, "送信を止めない");
  const item = EG.parseWebChannelForm(a.encode(r.model)).items[0].bytes;
  assert.deepEqual(item, msg(2, vint(1, 1), msg(9, str(1, decided))), "届く protobuf は、決めた本文を正しい長さで包んだものとバイト単位で同じ");
});
