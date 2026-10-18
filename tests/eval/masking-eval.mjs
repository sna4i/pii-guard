// tests/eval/masking-eval.mjs — マスキングの観点ベース大規模 eval (300+ ケース)。
//
// 目的: いろいろな視点 (観点) で作った架空文書をエンジン (regex/dict、ML/LLM 無し) に通し、
//   (a) 隠すべき値が隠れたか (recall / 漏れ)、(b) 隠してはいけない語を隠していないか (過検出)
//   を測る。ブラウザ不要・決定的。
//
// 観点 (viewpoint):
//   single     各カテゴリ単体 (自然文のラベルに埋め込み) × 全角数字
//   variant    現実の表記揺れ: 数字の間の IME 長音「ー」・‐ − – などのハイフン類
//   evasion    見えない文字 (ゼロ幅スペース等) が混ざったコピペ
//   name       姓名・敬称・家族・カナ/ローマ字の名義
//   org        部署・役職 (ラベル付き / 明確な役職語)
//   card       CVV・有効期限・下 4 桁
//   format     JSON / ログ / Markdown / CSV / メールヘッダ
//   composite  多カテゴリの現実文書 (顧客カルテ) とチャット文体
//   negative   隠してはいけない語 (過検出チェック)
//   gap        既知の限界 (数字を 1 桁ずつ空白で分断する難読化)。記録はするがゲート対象外
//
// 実行: node tests/eval/masking-eval.mjs [--verbose]
//   PII_EVAL_REPORT=<path> を付けると JSON レポートを書き出す。
// ゲート: 既知の限界を除いた recall が 100% かつ過検出 0 (tests/engine/masking-eval.test.mjs)。
import { createRequire } from "node:module";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const E = "../../browser-extension/engine/";
for (const m of ["dictionaries","patterns","classification","severity","categories","aggregate","force-mask","blocklist","user-force-mask","confidential","surrogates","llm-prompts"]) require(E + m + ".js");
const engine = require(E + "engine.js");

// ---- 変換 (表記揺れ・回避) -------------------------------------------------
const ZW = "​";
const toFull = (s) => s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
const spaceDigits = (s) => s.replace(/(\d)(?=\d)/g, "$1 ");
const zeroWidthDigits = (s) => s.replace(/(\d)(?=\d)/g, "$1" + ZW);
const zeroWidthChars = (s) => s.split("").join(ZW);
const withDash = (s, dash) => s.replace(/-/g, dash);

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
const DIGIT_CATS = ["phone", "postal", "mynumber", "bank", "card", "ip"];

// 隠してはいけない語 (過検出チェック)。「A型/B型」は血液型 = PII として意図的にマスクするので入れない。
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
  "ゲームのスコアは100点、レベルは3ー4の間",
  "家族の絵文字👨‍👩‍👧を送ってくれた",
];

export function buildCases() {
  let seq = 0;
  const cases = [];
  const add = (viewpoint, input, expectMasked, expectKept = [], opt = {}) =>
    cases.push({ id: ++seq, viewpoint, input, expectMasked, expectKept, gap: !!opt.gap });

  // single: 各カテゴリ単体 × (平文 / 全角数字 / 分断スペース=既知の限界)
  for (const [cat, label] of Object.entries(LABELS)) {
    for (const v of POOL[cat]) {
      add(`single:${cat}:plain`, label(v), [v]);
      if (DIGIT_CATS.includes(cat)) {
        add(`single:${cat}:full`, label(toFull(v)), [toFull(v)]);
        add(`gap:${cat}:spaced`, label(spaceDigits(v)), [spaceDigits(v)], [], { gap: true });
      }
    }
  }

  // variant: 数字の間のハイフン類 (IME の長音・各種ダッシュ)
  for (const v of POOL.phone) for (const d of ["ー", "‐", "−", "–"]) add("variant:phone-dash", LABELS.phone(withDash(v, d)), [withDash(v, d)]);
  for (const v of POOL.postal) for (const d of ["ー", "−"]) add("variant:postal-dash", LABELS.postal(withDash(v, d)), [withDash(v, d)]);
  add("variant:date-dash", "生年月日：1985ー03ー15", ["1985ー03ー15"]);
  add("variant:date-dash", "登録日 2026−09−20", ["2026−09−20"]);

  // evasion: ゼロ幅文字が混ざったコピペ (数字の間・文字の間)
  for (const v of POOL.phone) add("evasion:zw-phone", LABELS.phone(zeroWidthDigits(v)), [zeroWidthDigits(v)]);
  for (const v of POOL.mynumber) add("evasion:zw-mynumber", LABELS.mynumber(zeroWidthDigits(v)), [zeroWidthDigits(v)]);
  for (const v of POOL.card) add("evasion:zw-card", LABELS.card(zeroWidthDigits(v)), [zeroWidthDigits(v)]);
  for (const v of POOL.email) add("evasion:zw-email", LABELS.email(v.replace(".", ZW + ".")), [v.replace(".", ZW + ".")]);
  for (const s of POOL.surname.slice(0, 3)) add("evasion:zw-name", `氏名：${zeroWidthChars(s)}太郎`, [zeroWidthChars(s)]);

  // name: 姓名・敬称・家族・カナ/ローマ字名義
  for (const s of POOL.surname) for (const g of POOL.given.slice(0, 3)) {
    add("name:labeled", `氏名：${s} ${g}`, [`${s} ${g}`]);
    add("name:honorific", `担当の${s}${g}様より連絡がありました`, [`${s}${g}`]);
    add("name:family", `配偶者の${s}${g}を緊急連絡先に登録`, [`${s}${g}`]);
  }
  for (const k of POOL.katakana) add("name:holder-katakana", `口座名義${k}`, [k]);
  add("name:holder-romaji", "カード名義TARO YAMADA 有効期限12/30", ["TARO YAMADA"]);

  // org: 部署・役職
  for (const d of ["システム開発部 Webアプリケーション課", "営業本部 第一営業部", "人事部"]) add("org:dept-labeled", `部署：${d}`, [d]);
  for (const r of ["主任", "課長", "部長"]) add("org:role-labeled", `役職：${r}`, [r]);
  for (const r of ["代表取締役", "取締役", "CEO", "CFO"]) add("org:role-inline", `${r}の${POOL.surname[0]}${POOL.given[0]}が出席`, [r]);

  // card: CVV / 有効期限 / 下 4 桁
  add("card:cvv", "セキュリティコードについてはテスト上のみ「123」と設定", ["「123」"]);
  add("card:expiry", "有効期限12/30、カードは利用可能", ["12/30"]);
  add("card:last4", "登録電話番号の下4桁「5678」で本人確認", ["「5678」"]);

  // format: JSON / ログ / Markdown / CSV / メールヘッダ
  const rec = { name: "山田太郎", phone: "090-1234-5678", email: "taro.yamada@example.test", mynumber: "123456789012" };
  add("format:json", JSON.stringify(rec), [rec.name, rec.phone, rec.email, rec.mynumber]);
  add("format:json-pretty", JSON.stringify(rec, null, 2), [rec.phone, rec.email]);
  add("format:log", "2026-09-20 18:15 INFO Customer: C-00045872 phone=090-1234-5678 email=taro.yamada@example.test", ["C-00045872", "090-1234-5678", "taro.yamada@example.test"]);
  add("format:markdown", "## 顧客情報\n- 氏名: 山田太郎\n- 電話: 090-1234-5678\n- [メール](mailto:taro.yamada@example.test)", ["山田太郎", "090-1234-5678", "taro.yamada@example.test"]);
  add("format:csv", "name,phone,email\n山田太郎,090-1234-5678,taro.yamada@example.test", ["090-1234-5678", "taro.yamada@example.test"]);
  add("format:mail-header", "From: 山田太郎 <taro.yamada@example.test>\nTel: 090-1234-5678", ["taro.yamada@example.test", "090-1234-5678"]);

  // composite: 顧客カルテ (多カテゴリ) とチャット文体
  for (let i = 0; i < 60; i++) {
    const s = POOL.surname[i % POOL.surname.length], g = POOL.given[i % POOL.given.length];
    const ph = POOL.phone[i % POOL.phone.length], em = POOL.email[i % POOL.email.length];
    const ad = POOL.address[i % POOL.address.length], co = POOL.company[i % POOL.company.length];
    const mn = POOL.mynumber[i % POOL.mynumber.length], cc = POOL.card[i % POOL.card.length];
    const ip = POOL.ip[i % POOL.ip.length], cu = POOL.custid[i % POOL.custid.length];
    add("composite:record",
      `【顧客カルテ】\n氏名：${s}${g}\n電話番号：${ph}\nメール：${em}\n住所：${ad}\n勤務先：${co}\nマイナンバー：${mn}\nカード番号 ${cc}\n最終ログインIP：${ip}\nINFO Customer accessed: ${cu}`,
      [`${s}${g}`, ph, em, ad, co, mn, cc, ip, cu]);
  }
  for (let i = 0; i < 48; i++) {
    const s = POOL.surname[i % POOL.surname.length], ph = POOL.phone[(i + 1) % POOL.phone.length], em = POOL.email[(i + 2) % POOL.email.length];
    add("composite:chat", `お世話になります。${s}です。携帯は${ph}、メールは${em}までお願いします。ちなみにCSSのwidth:50%の件も了解です。`, [ph, em], ["width:50%"]);
  }

  // negative: 隠してはいけない語
  for (const n of NEGATIVES) add("negative:prose", n, [], [n]);
  add("negative:css", "style に width: 50% と height: 100% を指定", [], ["width: 50%", "height: 100%"]);
  add("negative:prose-num", "出席者は約30人、会議は3回に分けて実施", [], ["30人", "3回"]);
  add("negative:common", "全部の作業のうち一部が完了。残りは主任研修の後", [], ["全部", "一部", "主任研修"]);

  return cases;
}

export async function runEval() {
  const cases = buildCases();
  const byVp = new Map();
  const leaks = [], gapLeaks = [], falsePositives = [];
  let expectAll = 0, maskedAll = 0, expectGate = 0, maskedGate = 0, fpCount = 0;
  for (const c of cases) {
    const out = (await engine.maskSanitize(c.input, { mlEnabled: false })).sanitized_text;
    const leaked = c.expectMasked.filter((v) => v && out.includes(v));
    const masked = c.expectMasked.length - leaked.length;
    const overMasked = c.expectKept.filter((v) => v && !out.includes(v));
    expectAll += c.expectMasked.length; maskedAll += masked;
    if (!c.gap) { expectGate += c.expectMasked.length; maskedGate += masked; }
    fpCount += overMasked.length;
    const vp = c.viewpoint.split(":")[0];
    const a = byVp.get(vp) || { cases: 0, expect: 0, masked: 0, fp: 0 };
    a.cases++; a.expect += c.expectMasked.length; a.masked += masked; a.fp += overMasked.length;
    byVp.set(vp, a);
    if (leaked.length) (c.gap ? gapLeaks : leaks).push({ id: c.id, viewpoint: c.viewpoint, leaked });
    if (overMasked.length) falsePositives.push({ id: c.id, viewpoint: c.viewpoint, overMasked });
  }
  return {
    cases: cases.length,
    recall: maskedAll / (expectAll || 1), maskedAll, expectAll,
    gateRecall: maskedGate / (expectGate || 1), maskedGate, expectGate,
    fpCount, byViewpoint: Object.fromEntries(byVp), leaks, gapLeaks, falsePositives,
  };
}

// ---- CLI -------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const verbose = process.argv.includes("--verbose");
  const r = await runEval();
  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log(`\n=== マスキング eval: ${r.cases} ケース ===`);
  console.log(`recall (全体、既知の限界を含む): ${pct(r.recall)}  (${r.maskedAll}/${r.expectAll})`);
  console.log(`recall (ゲート、既知の限界を除く): ${pct(r.gateRecall)}  (${r.maskedGate}/${r.expectGate})`);
  console.log(`過検出: ${r.fpCount}`);
  console.log("\n観点別:");
  for (const [vp, a] of Object.entries(r.byViewpoint).sort()) {
    console.log(`  ${vp.padEnd(10)} cases=${String(a.cases).padStart(3)} recall=${(((a.masked / (a.expect || 1)) * 100).toFixed(0) + "%").padStart(4)} (${a.masked}/${a.expect}) 過検出=${a.fp}`);
  }
  const show = (title, list) => {
    if (!list.length) return;
    console.log(`\n${title} (${list.length} ケース):`);
    for (const l of list.slice(0, verbose ? 999 : 20)) console.log(`  #${l.id} [${l.viewpoint}] -> ${JSON.stringify(l.leaked || l.overMasked)}`);
    if (!verbose && list.length > 20) console.log(`  … 他 ${list.length - 20} 件 (--verbose で全部)`);
  };
  show("漏れ", r.leaks);
  show("既知の限界 (ゲート対象外)", r.gapLeaks);
  show("過検出", r.falsePositives);
  if (process.env.PII_EVAL_REPORT) {
    fs.writeFileSync(process.env.PII_EVAL_REPORT, JSON.stringify(r, null, 2));
    console.log(`\nレポート: ${process.env.PII_EVAL_REPORT}`);
  }
  const ok = r.gateRecall === 1 && r.fpCount === 0;
  console.log(ok ? `\n✅ ゲート合格 (recall 100% / 過検出 0)` : `\n❌ ゲート不合格`);
  process.exit(ok ? 0 : 1);
}
