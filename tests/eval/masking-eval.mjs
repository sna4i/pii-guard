// tests/eval/masking-eval.mjs — マスキングの観点ベース大規模 eval (300 ケース)。
//
// 目的: いろいろな視点 (観点) で作った架空文書をエンジン (regex/dict、ML/LLM 無し) に通し、
//   (a) 隠すべき値が隠れたか (recall / 漏れ)、(b) 隠してはいけない語を隠していないか (過検出)
//   を測る。ブラウザ不要・決定的。
//
// 実行: node tests/eval/masking-eval.mjs [--verbose]
//   PII_EVAL_REPORT=<path> を付けると JSON レポートを書き出す。
// 終了コード: recall が閾値 (既定 0.9) 未満、または過検出があれば 1。
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const E = "../../browser-extension/engine/";
for (const m of ["dictionaries","patterns","classification","severity","categories","aggregate","force-mask","blocklist","user-force-mask","confidential","surrogates","llm-prompts"]) require(E + m + ".js");
const engine = require(E + "engine.js");

const VERBOSE = process.argv.includes("--verbose");

// ---- 難読化の変換 (観点: 表記揺れ・回避) ---------------------------------
const toFull = (s) => s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
const spaceDigits = (s) => s.replace(/(\d)(?=\d)/g, "$1 ");
const hyphenToFull = (s) => s.replace(/-/g, "ー");
const zeroWidth = (s) => s.split("").join("​");
const OBF = { plain: (s) => s, full: toFull, spaced: spaceDigits };

// ---- 値プール (すべて架空) ------------------------------------------------
const POOL = {
  surname: ["山田", "佐藤", "鈴木", "高橋", "田中", "渡辺", "伊藤", "中村"],
  given: ["太郎", "花子", "一郎", "美咲", "健太", "さくら"],
  katakana: ["ヤマダ タロウ", "サトウ ハナコ", "タナカ ケンタ"],
  phone: ["090-1234-5678", "080-9876-5432", "03-1234-5678", "0120-000-111"],
  email: ["taro.yamada@example.test", "hanako_s@sample.example", "k.tanaka@test.example.jp"],
  postal: ["150-0001", "100-0005", "060-0042"],
  address: ["東京都渋谷区神南1-2-3", "大阪府大阪市北区梅田2-4-9", "北海道札幌市中央区北1条西2-3"],
  building: ["サンプルレジデンス渋谷1204号室", "テストビル8階", "グランドタワー大阪3301号室"],
  company: ["株式会社テストコーポレーション", "有限会社サンプル商事", "合同会社ダミーワークス"],
  dob: ["1985-03-15", "1990/07/22", "2001年11月3日"],
  mynumber: ["123456789012", "987654321098"],
  dl: ["第123456789012号", "第987654321000号"],
  passport: ["TK1234567", "XS9876543"],
  bank: ["1234567", "7654321"],
  card: ["4111-1111-1111-1111", "5500 0000 0000 0004"],
  ip: ["192.168.1.100", "10.0.0.5"],
  empid: ["EMP-458721", "STAFF-00231"],
  custid: ["C-00045872", "CUST-889900"],
  order: ["ORD-20260920-785412", "PO-1234567"],
  apikey: ["sk-test-abcdefghijklmnop12345678", "AKIAIOSFODNN7EXAMPLE"],
};

// 隠してはいけない語 (観点: 過検出) ------------------------------------------
const NEGATIVES = [
  "CSS の width: 50% が効かない",
  "作業は一部だけ完了した。全部やるには時間がかかる",
  "3階建ての一戸建てに住んでいます",
  "新人の主任研修を実施した",
  "会議は10時から、参加者は約30人でした",
  "気温は25度、湿度は60%",
  "テストは5回中3回成功した",
  "バージョン1.2.3をリリース",
  "これは普通の文章で、個人情報は含まれていません",
  // 注: 「A型/B型」は血液型=PII として意図的にマスクするので negative には入れない。
];

let seq = 0;
const cases = [];
const add = (viewpoint, input, expectMasked, expectKept = []) => cases.push({ id: ++seq, viewpoint, input, expectMasked, expectKept });

// 観点1: 各カテゴリ単体 × 難読化 (ラベル付きの自然文に埋め込む)
const LABELS = {
  surname: (v) => `氏名：${v}太郎`, katakana: (v) => `フリガナ：${v}`,
  phone: (v) => `電話番号は${v}です`, email: (v) => `連絡先メール：${v}`,
  postal: (v) => `郵便番号 ${v}`, address: (v) => `住所：${v}`,
  building: (v) => `住所：東京都渋谷区神南1-2-3 ${v}`,
  company: (v) => `勤務先：${v}`, dob: (v) => `生年月日：${v}`,
  mynumber: (v) => `マイナンバー：${v}`, dl: (v) => `運転免許証番号：${v}`,
  passport: (v) => `パスポート番号：${v}`, bank: (v) => `銀行口座：普通 ${v}`,
  card: (v) => `カード番号 ${v}`, ip: (v) => `最終ログインIP：${v}`,
  empid: (v) => `社員番号：${v}`, custid: (v) => `INFO Customer accessed: ${v}`,
  order: (v) => `注文番号${v}の商品`, apikey: (v) => `APIキー: ${v}`,
};
const DIGIT_CATS = new Set(["phone", "postal", "mynumber", "bank", "card", "ip"]);
for (const [cat, label] of Object.entries(LABELS)) {
  const vals = POOL[cat] || [POOL.surname[0]];
  for (const v of vals) {
    add(`single:${cat}:plain`, label(v), [v]);
    // 難読化は数字系だけ (名前等の全角化は別物になるため)
    if (DIGIT_CATS.has(cat)) {
      add(`single:${cat}:full`, label(toFull(v)), [toFull(v)]);
      add(`single:${cat}:spaced`, label(spaceDigits(v)), [spaceDigits(v)]);
    }
  }
}

// 観点2: 氏名のバリエーション (姓+名、敬称、家族、カタカナ、名義)
for (const s of POOL.surname) for (const g of POOL.given.slice(0, 3)) {
  add("name:labeled", `氏名：${s} ${g}`, [`${s} ${g}`]);
  add("name:honorific", `担当の${s}${g}様より連絡がありました`, [`${s}${g}`]);
  add("name:family", `配偶者の${s}${g}を緊急連絡先に登録`, [`${s}${g}`]);
}
for (const k of POOL.katakana) add("name:holder-katakana", `口座名義${k}`, [k]);
add("name:holder-romaji", "カード名義TARO YAMADA 有効期限12/30", ["TARO YAMADA"]);

// 観点3: 部署・役職 (ラベル有無)
for (const d of ["システム開発部 Webアプリケーション課", "営業本部 第一営業部", "人事部"]) add("org:dept-labeled", `部署：${d}`, [d]);
for (const r of ["主任", "課長", "部長"]) add("org:role-labeled", `役職：${r}`, [r]);
for (const r of ["代表取締役", "取締役", "CEO", "CFO"]) add("org:role-inline", `${r}の${POOL.surname[0]}${POOL.given[0]}が出席`, [r]);

// 観点4: カード周辺 (CVV/有効期限/下4桁)
add("card:cvv", "セキュリティコードについてはテスト上のみ「123」と設定", ["「123」"]);
add("card:expiry", "有効期限12/30、カードは利用可能", ["12/30"]);
add("card:last4", "登録電話番号の下4桁「5678」で本人確認", ["「5678」"]);

// 観点5: 形式別 (JSON / ログ / Markdown / CSV / メール形式)
const rec = { name: "山田太郎", phone: "090-1234-5678", email: "taro.yamada@example.test", mynumber: "123456789012" };
add("format:json", JSON.stringify(rec), [rec.name, rec.phone, rec.email, rec.mynumber]);
add("format:json-pretty", JSON.stringify(rec, null, 2), [rec.phone, rec.email]);
add("format:log", `2026-09-20 18:15 INFO Customer: C-00045872 phone=090-1234-5678 email=taro.yamada@example.test`, ["C-00045872", "090-1234-5678", "taro.yamada@example.test"]);
add("format:markdown", `## 顧客情報\n- 氏名: 山田太郎\n- 電話: 090-1234-5678\n- [メール](mailto:taro.yamada@example.test)`, ["山田太郎", "090-1234-5678", "taro.yamada@example.test"]);
add("format:csv", `name,phone,email\n山田太郎,090-1234-5678,taro.yamada@example.test`, ["090-1234-5678", "taro.yamada@example.test"]);
add("format:mail-header", `From: 山田太郎 <taro.yamada@example.test>\nTel: 090-1234-5678`, ["taro.yamada@example.test", "090-1234-5678"]);

// 観点6: 複合の現実文書 (多カテゴリ) — テンプレ × 値で量産
function record(i) {
  const s = POOL.surname[i % POOL.surname.length], g = POOL.given[i % POOL.given.length];
  const ph = POOL.phone[i % POOL.phone.length], em = POOL.email[i % POOL.email.length];
  const ad = POOL.address[i % POOL.address.length], co = POOL.company[i % POOL.company.length];
  const mn = POOL.mynumber[i % POOL.mynumber.length], cc = POOL.card[i % POOL.card.length];
  const ip = POOL.ip[i % POOL.ip.length], cu = POOL.custid[i % POOL.custid.length];
  const input = `【顧客カルテ】\n氏名：${s}${g}\n電話番号：${ph}\nメール：${em}\n住所：${ad}\n勤務先：${co}\nマイナンバー：${mn}\nカード番号 ${cc}\n最終ログインIP：${ip}\nINFO Customer accessed: ${cu}`;
  return { input, expect: [`${s}${g}`, ph, em, ad, co, mn, cc, ip, cu] };
}
for (let i = 0; i < 60; i++) { const r = record(i); add("composite:record", r.input, r.expect); }

// チャット文体 (観点: 口語・混在)
function chat(i) {
  const s = POOL.surname[i % POOL.surname.length], ph = POOL.phone[(i + 1) % POOL.phone.length], em = POOL.email[(i + 2) % POOL.email.length];
  return { input: `お世話になります。${s}です。携帯は${ph}、メールは${em}までお願いします。ちなみにCSSのwidth:50%の件も了解です。`, expect: [ph, em], keep: ["width:50%"] };
}
for (let i = 0; i < 48; i++) { const c = chat(i); add("composite:chat", c.input, c.expect, c.keep); }

// 観点7: 過検出 (隠してはいけない語)
for (const n of NEGATIVES) add("negative", n, [], [n.match(/width: 50%|一部|全部|3階建て|主任研修|30人|25度|60%|5回|3回|1\.2\.3/g) ? n : n]);
// 代表的な「残すべき」部分文字列を明示
add("negative:css", "style に width: 50% と height: 100% を指定", [], ["width: 50%", "height: 100%"]);
add("negative:prose-num", "出席者は約30人、会議は3回に分けて実施", [], ["30人", "3回"]);
add("negative:common", "全部の作業のうち一部が完了。残りは主任研修の後", [], ["全部", "一部", "主任研修"]);

// 観点8: ゼロ幅・全角混在の氏名/番号 (回避耐性。参考値として記録、閾値には含めるが別集計)
add("evasion:zw-phone", `電話番号は${zeroWidth("09012345678")}です`, [zeroWidth("09012345678")]);
add("evasion:full-mynumber", `マイナンバー：${toFull("123456789012")}`, [toFull("123456789012")]);

// ---- 実行 -----------------------------------------------------------------
const results = [];
const byVp = new Map();
let totalExpect = 0, totalMasked = 0, fpCount = 0;
const leaks = [], falsePositives = [];

for (const c of cases) {
  const r = await engine.maskSanitize(c.input, { mlEnabled: false });
  const out = r.sanitized_text;
  const maskedVals = c.expectMasked.filter((v) => v && !out.includes(v));
  const leakedVals = c.expectMasked.filter((v) => v && out.includes(v));
  const keptOk = c.expectKept.filter((v) => v && out.includes(v));
  const overMasked = c.expectKept.filter((v) => v && !out.includes(v));
  totalExpect += c.expectMasked.length;
  totalMasked += maskedVals.length;
  fpCount += overMasked.length;
  const vp = c.viewpoint.split(":")[0];
  const agg = byVp.get(vp) || { expect: 0, masked: 0, fp: 0, cases: 0 };
  agg.expect += c.expectMasked.length; agg.masked += maskedVals.length; agg.fp += overMasked.length; agg.cases++;
  byVp.set(vp, agg);
  if (leakedVals.length) leaks.push({ id: c.id, viewpoint: c.viewpoint, leaked: leakedVals });
  if (overMasked.length) falsePositives.push({ id: c.id, viewpoint: c.viewpoint, overMasked });
  results.push({ id: c.id, vp: c.viewpoint, leaked: leakedVals, overMasked });
}

const recall = totalMasked / (totalExpect || 1);
console.log(`\n=== マスキング eval: ${cases.length} ケース ===`);
console.log(`recall (隠すべき値が隠れた率): ${(recall * 100).toFixed(1)}%  (${totalMasked}/${totalExpect})`);
console.log(`過検出 (隠してはいけない語を隠した数): ${fpCount}`);
console.log(`\n観点別:`);
for (const [vp, a] of [...byVp.entries()].sort()) {
  console.log(`  ${vp.padEnd(12)} cases=${String(a.cases).padStart(3)} recall=${((a.masked / (a.expect || 1)) * 100).toFixed(0).padStart(3)}% (${a.masked}/${a.expect}) 過検出=${a.fp}`);
}
if (leaks.length) {
  console.log(`\n漏れ (${leaks.length} ケース):`);
  for (const l of leaks.slice(0, VERBOSE ? 999 : 30)) console.log(`  #${l.id} [${l.viewpoint}] -> ${JSON.stringify(l.leaked)}`);
  if (!VERBOSE && leaks.length > 30) console.log(`  … 他 ${leaks.length - 30} 件 (--verbose で全部)`);
}
if (falsePositives.length) {
  console.log(`\n過検出 (${falsePositives.length} ケース):`);
  for (const f of falsePositives.slice(0, 50)) console.log(`  #${f.id} [${f.viewpoint}] -> ${JSON.stringify(f.overMasked)}`);
}

if (process.env.PII_EVAL_REPORT) {
  fs.writeFileSync(process.env.PII_EVAL_REPORT, JSON.stringify({ cases: cases.length, recall, totalMasked, totalExpect, fpCount, byViewpoint: Object.fromEntries(byVp), leaks, falsePositives }, null, 2));
  console.log(`\nレポート: ${process.env.PII_EVAL_REPORT}`);
}

const THRESHOLD = 0.9;
if (recall < THRESHOLD || fpCount > 0) { console.log(`\n❌ 閾値未達 (recall<${THRESHOLD}) か過検出あり`); process.exit(1); }
console.log(`\n✅ recall ${(recall * 100).toFixed(1)}% / 過検出 0`);
