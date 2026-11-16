// tests/e2e/pro-custom-rules-options.test.mjs — 設定画面の Pro のカスタムルールのカード
// (Pro Phase 2 の設計 (P1)、T-CR-41〜45・47〜51・56。T-CR-46 は ID が仮の版が要るので別のファイル)
//
// 土台は tests/fixtures/pro-ext.mjs の launchPro (拡張機能の写し + 模擬の ExtensionPay。入れた直後はお試しの Pro)。
// 設定画面 (options.html) を開き、フォームの入力・一覧・読み込み・書き出しを、ふつうの利用者と同じように操作する。
// 保存と読み込みの確かめは Worker (options-rules-worker.js) で走る。固まる正規表現 (T-CR-47) で、画面が固まらず、
// 1 本ごとに 1 秒で断ることを確かめる。ルールの値はすべて架空のもの。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launchPro } from "../fixtures/pro-ext.mjs";

const DAY = 24 * 3600 * 1000;
const EXPORT_FILE = "pii-guard-custom-rules.json";
const NOTE_NOT_PRO = "カスタムルールは Pro の機能です";
const NOTE_EXPORT = "書き出したファイルには、顧客名などが入ることがあります。扱いに気を付けてください";
const NOTE_LLM = "カスタムルールを使っているあいだは、LLM の置き換えモードは使わず、いつもの伏せ方で送ります";
// 単語リストは大文字と小文字を区別する (区別しない選択は作らない。正規表現の ignoreCase を案内する)
const NOTE_CASE = "大文字と小文字は区別します (区別しないときは正規表現で ignoreCase を使ってください)";
const TIMEOUT_REASON = "時間がかかりすぎる正規表現です";
// validateRule を通り、stressTest が 60 字で止まらない形 (Pro Phase 2 の設計 (P1) の実測)。画面のスレッドで試すと画面ごと固まる
const HANG_PATTERN = String.raw`(?:[a-z][a-z]?)*(?<!x)\s+\d`;
const HYPHEN_EXAMPLES = ["[ァ-ヶー-]", "[ァ-ヶ][ァ-ヶー]*", "[ー-]"];

const WORDS_RULE = { id: "r-words", label: "PROJECT", kind: "words", words: ["アルファ計画"], match: "exact", enabled: true };
const REGEX_RULE = { id: "r-regex", label: "ACME_ID", kind: "regex", pattern: "ACME-\\d{4}", ignoreCase: false, enabled: true };
const fileOf = (rules) => JSON.stringify({ format: "pii-guard-custom-rules", version: 1, rules });

let h;
let close;
before(async () => {
  ({ h, close } = await launchPro({}));
  await waitPro(true);
});
after(async () => {
  if (close) await close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (msg) => h.ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
// お試しの Pro (または購入済み) かどうかを、want になるまで待つ (入れた直後は、ExtPay がインストールの日時を書くのを待つ)
async function waitPro(want) {
  for (let i = 0; i < 50; i++) {
    if ((await ask({ type: "license:get", refresh: true })).pro === want) return;
    await sleep(100);
  }
  assert.fail(`license:get の pro が ${want} にならない`);
}
// お試しの始まり (ExtPay が覚えているインストールの日時) を替えて確かめ直し、Pro かどうかを返す
async function setInstalledAt(ms) {
  await h.ext.evaluate((t) => chrome.storage.sync.set({ extensionpay_installed_at: new Date(t).toISOString() }), ms);
  return (await ask({ type: "license:get", refresh: true })).pro;
}
// 保存してあるルールを置き換える (null なら消す)。開いている設定画面には、storage の変化で伝わる
const setRules = (rules) => h.ext.evaluate(async (r) => {
  if (r === null) await chrome.storage.local.remove("proCustomRules");
  else await chrome.storage.local.set({ proCustomRules: { version: 1, rules: r } });
}, rules);
const savedRules = async () => (await h.getStorage(["proCustomRules"])).proCustomRules;
// storage の書き込みが、画面の操作から少し遅れて見えるときのための待ち
async function waitStored(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await sleep(100);
  }
  assert.fail("storage の値が期待の形にならない");
}

async function openOptions() {
  const p = await h.ctx.newPage();
  p.__errors = [];
  p.on("pageerror", (e) => p.__errors.push(String((e && e.stack) || e)));
  await p.goto(`chrome-extension://${h.extId}/options.html`);
  return p;
}
// カードが出る (hidden が外れる) まで待つ。出なければ、理由が分かる文で落とす
async function openCard() {
  const p = await openOptions();
  try {
    await p.waitForFunction(() => { const c = document.getElementById("custom-rules-card"); return !!c && !c.hidden; }, null, { timeout: 5000 });
  } catch (_) {
    await p.close();
    assert.fail("カード (#custom-rules-card) が無いか、hidden のまま");
  }
  return p;
}
// 一覧の行の数が n になるまで待つ
const waitRows = (p, n, timeout = 8000) => p.waitForFunction((want) => document.querySelectorAll("#cr-list .cr-item").length === want, n, { timeout });
// 保存の最後 (フォームを空に戻し、「保存しました」を出す) まで待つ。一覧に行が出るのは、storage の変化で先になることがある
const waitSaved = (p) => p.waitForFunction(() => document.getElementById("cr-status").textContent === "保存しました", null, { timeout: 8000 });
const rowTexts = (p) => p.$$eval("#cr-list .cr-item", (rows) => rows.map((r) => r.textContent));
const errorLines = (p) => p.$$eval("#cr-errors > *", (els) => els.map((e) => e.textContent));
const row = (p, i) => p.locator("#cr-list .cr-item").nth(i);

async function fillWords(p, { label = "", words, match = "exact" }) {
  await p.selectOption("#cr-kind", "words");
  await p.fill("#cr-label", label);
  await p.fill("#cr-words", words.join("\n"));
  await p.selectOption("#cr-match", match);
}
async function fillRegex(p, { label = "", pattern, ignoreCase = false }) {
  await p.selectOption("#cr-kind", "regex");
  await p.fill("#cr-label", label);
  await p.fill("#cr-pattern", pattern);
  await p.setChecked("#cr-ignore-case", ignoreCase);
}
// 保存を押す。結果 (一覧の行・エラーの行) は、各テストが必要な形で待つ
const save = (p) => p.click("#cr-save");
// 読み込む: ファイルを選び、結果の欄に want が出るまで待って、欄の中身を返す
async function importText(p, text, want, name = "rules.json") {
  await p.setInputFiles("#cr-import", { name, mimeType: "application/json", buffer: Buffer.from(text) });
  await p.waitForFunction((w) => document.getElementById("cr-import-result").textContent.includes(w), want, { timeout: 15000 });
  return p.textContent("#cr-import-result");
}

test("T-CR-41 Pro (お試し) のとき: フォームから単語リストのルールを保存すると、proCustomRules に入り、一覧に出る。LLM の置き換えモードの一文が見える", async () => {
  await setRules(null);
  const p = await openCard();
  try {
    assert.equal(await p.isVisible("#cr-pro-note"), false, "Pro のあいだは、Pro の機能という案内を出さない");
    assert.equal(await p.isDisabled("#cr-save"), false, "Pro のあいだは、保存を押せる");
    assert.ok((await p.textContent("#custom-rules-card")).includes(NOTE_LLM), "置き換えモードを入れている人が気づける一文");
    assert.ok((await p.textContent("#cr-words-fields")).includes(NOTE_CASE), "語の欄に、大文字と小文字を区別することと、区別しないときの書き方がある");
    await waitRows(p, 0);

    await fillWords(p, { label: "PROJECT", words: ["アルファ計画", "ベータ計画", ""], match: "exact" });
    await save(p);
    await waitRows(p, 1);
    await waitSaved(p);

    const saved = await savedRules();
    assert.equal(saved.version, 1);
    assert.equal(saved.rules.length, 1);
    const { id, ...rest } = saved.rules[0];
    assert.ok(typeof id === "string" && id.length > 0, "id が付く");
    assert.deepEqual(rest, { label: "PROJECT", kind: "words", enabled: true, words: ["アルファ計画", "ベータ計画"], match: "exact" }, "空の行は落ち、有効で保存される");
    const [text] = await rowTexts(p);
    assert.match(text, /PROJECT/, "名前");
    assert.match(text, /単語リスト/, "種類");
    assert.match(text, /2 語/, "語の数");
    assert.equal(await p.locator("#cr-list .cr-item .switch input").first().isChecked(), true, "有効の切り替えがオン");
    assert.deepEqual(await errorLines(p), [], "エラーの行は無い");
    assert.equal(await p.inputValue("#cr-words"), "", "保存したあと、フォームは空に戻る");

    // 正規表現も保存でき、一覧にはパターンが出る。名前を空にすると CUSTOM
    await fillRegex(p, { pattern: "ACME-\\d{4}", ignoreCase: true });
    await save(p);
    await waitRows(p, 2);
    await waitSaved(p);
    const after = (await savedRules()).rules;
    assert.equal(after.length, 2);
    assert.deepEqual(after[1] && { label: after[1].label, kind: after[1].kind, pattern: after[1].pattern, ignoreCase: after[1].ignoreCase, enabled: after[1].enabled },
      { label: "CUSTOM", kind: "regex", pattern: "ACME-\\d{4}", ignoreCase: true, enabled: true });
    assert.match((await rowTexts(p))[1], /ACME-\\d\{4\}/, "一覧に、パターンがそのまま出る");
    assert.deepEqual(p.__errors, [], "ページのエラーは無い");
  } finally { await p.close(); }
});

test("T-CR-42 保存できないもの: 文法の誤り・(a+)+・小文字の名前は、理由が 1 行ずつ出て保存されない。ハイフン類で断ると書き直しの例を足す。50 個を超える追加も断る", async () => {
  await setRules(null);
  const p = await openCard();
  try {
    // 文法の誤り
    await fillRegex(p, { pattern: "(abc" });
    await save(p);
    await p.waitForFunction(() => document.querySelectorAll("#cr-errors > *").length > 0, null, { timeout: 8000 });
    let lines = await errorLines(p);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /正規表現として正しくありません/);
    assert.equal(await savedRules(), undefined, "保存されていない");

    // 入れ子の繰り返し
    await fillRegex(p, { pattern: "(a+)+" });
    await save(p);
    await p.waitForFunction(() => document.getElementById("cr-errors").textContent.includes("時間がかかりやすい形です"), null, { timeout: 8000 });
    assert.equal((await errorLines(p)).length, 1, "前の理由は消えて、今の理由だけ");
    assert.equal(await savedRules(), undefined);

    // 小文字の名前
    await fillWords(p, { label: "project", words: ["アルファ計画"] });
    await save(p);
    await p.waitForFunction(() => document.getElementById("cr-errors").textContent.includes("伏せ字の名前は英大文字で始め"), null, { timeout: 8000 });
    assert.equal(await savedRules(), undefined);

    // 理由が 2 つあれば、2 行に分かれる
    await fillRegex(p, { label: "project", pattern: "(abc" });
    await save(p);
    await p.waitForFunction(() => document.querySelectorAll("#cr-errors > *").length === 2, null, { timeout: 8000 });
    lines = await errorLines(p);
    assert.ok(lines.some((l) => l.includes("伏せ字の名前は英大文字で始め")) && lines.some((l) => l.includes("正規表現として正しくありません")), lines.join(" / "));
    assert.equal(await savedRules(), undefined);

    // ハイフン類で断られる (見た目にハイフンの無い [ァ-ヶー]+ でも断られる) と、書き直しの例の行が足される。例はどれも通る
    await fillRegex(p, { pattern: "[ァ-ヶー]+" });
    await save(p);
    await p.waitForFunction(() => document.getElementById("cr-errors").textContent.includes("ハイフン類"), null, { timeout: 8000 });
    lines = await errorLines(p);
    assert.equal(lines.length, 2, `理由の行と、書き直しの例の行: ${lines.join(" / ")}`);
    for (const example of HYPHEN_EXAMPLES) assert.ok(lines[1].includes(example), `書き直しの例 ${example}`);
    assert.equal(await savedRules(), undefined);
    for (const [i, example] of HYPHEN_EXAMPLES.entries()) {
      await fillRegex(p, { label: `HY${i}`, pattern: example });
      await save(p);
      await waitRows(p, i + 1);
      assert.deepEqual(await errorLines(p), [], `例 ${example} は保存できる`);
    }
    assert.equal((await savedRules()).rules.length, 3);

    // 50 個あれば、新しいものは保存しない (理由を出す)。50 個のままで、増えない
    const fifty = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, label: "CUSTOM", kind: "words", words: [`語${i}`], match: "partial", enabled: true }));
    await setRules(fifty);
    await waitRows(p, 50);
    await fillWords(p, { label: "EXTRA", words: ["アルファ計画"] });
    await save(p);
    await p.waitForFunction(() => document.getElementById("cr-errors").textContent.includes("50 個まで"), null, { timeout: 8000 });
    assert.equal((await savedRules()).rules.length, 50, "50 個のまま");
    assert.deepEqual(p.__errors, [], "ページのエラーは無い");
  } finally { await p.close(); }
});

test("T-CR-43 読み込み: 正しい 1 件・壊れた 1 件・同じ 1 件のファイルで「追加 1 件、同じルール 1 件、読み込めなかったもの 1 件」。壊れた JSON のファイルなら、今のルールは変わらず理由が出る", async () => {
  await setRules([WORDS_RULE]);
  const p = await openCard();
  try {
    await waitRows(p, 1);
    const incoming = [
      { id: "in-1", label: "ACME_ID", kind: "regex", pattern: "ACME-\\d{4}", ignoreCase: false, enabled: true }, // 正しい → 追加
      { id: "in-2", label: "BROKEN", kind: "regex", pattern: "(abc", enabled: true }, // 壊れた → 読み込めなかったもの
      { ...WORDS_RULE, id: "other-id" }, // 中身が今のルールと同じ (id は違う) → 同じルール
    ];
    const result = await importText(p, fileOf(incoming), "追加 1 件、同じルール 1 件、読み込めなかったもの 1 件");
    assert.match(result, /追加 1 件、同じルール 1 件、読み込めなかったもの 1 件/);
    assert.match(result, /2 件目/, "どのルールかが分かる");
    assert.match(result, /正規表現として正しくありません/, "読み込めなかった理由");
    const saved = (await savedRules()).rules;
    assert.equal(saved.length, 2, "今のルール + 追加の 1 件");
    assert.deepEqual(saved[0], WORDS_RULE, "今のルールは変わらない");
    assert.equal(saved[1].label, "ACME_ID");
    await waitRows(p, 2);

    // もう一度読み込むと、足されない (同じルール 2 件)
    const again = await importText(p, fileOf(incoming.slice(0, 1).concat(incoming.slice(2))), "追加 0 件、同じルール 2 件、読み込めなかったもの 0 件");
    assert.match(again, /追加 0 件、同じルール 2 件、読み込めなかったもの 0 件/);
    assert.equal((await savedRules()).rules.length, 2);

    // ファイル全体が読めないとき: 今のルールは 1 つも変わらず、理由だけが出る (件数の行は出さない)
    const before = await savedRules();
    const broken = await importText(p, "{ これは JSON ではありません", "JSON として読めません", "broken.json");
    assert.doesNotMatch(broken, /追加 \d+ 件/, "ファイル全体が読めないときは、件数の行を出さない");
    const wrongFormat = await importText(p, JSON.stringify({ format: "other-tool", version: 1, rules: [] }), "ファイルではありません", "other.json");
    assert.doesNotMatch(wrongFormat, /追加 \d+ 件/);
    const wrongVersion = await importText(p, JSON.stringify({ format: "pii-guard-custom-rules", version: 2, rules: [] }), "version 1 だけ", "v2.json");
    assert.doesNotMatch(wrongVersion, /追加 \d+ 件/);
    const notArray = await importText(p, JSON.stringify({ format: "pii-guard-custom-rules", version: 1, rules: {} }), "配列ではありません", "obj.json");
    assert.doesNotMatch(notArray, /追加 \d+ 件/);
    assert.deepEqual(await savedRules(), before, "読めないファイルでは、今のルールは 1 つも変わらない");
    assert.deepEqual(p.__errors, [], "ページのエラーは無い");
  } finally { await p.close(); }
});

test("T-CR-44 書き出し: ダウンロードされた JSON の format と rules が保存したものと合い、注意の一文が見える", async () => {
  const rules = [WORDS_RULE, REGEX_RULE];
  await setRules(rules);
  const p = await openCard();
  try {
    await waitRows(p, 2);
    assert.equal(await p.isVisible("#cr-export-note"), true, "注意の一文が見える");
    assert.equal((await p.textContent("#cr-export-note")).trim(), NOTE_EXPORT);
    const [download] = await Promise.all([p.waitForEvent("download", { timeout: 10000 }), p.click("#cr-export")]);
    assert.equal(download.suggestedFilename(), EXPORT_FILE);
    const body = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    assert.equal(body.format, "pii-guard-custom-rules");
    assert.equal(body.version, 1);
    assert.deepEqual(body.rules, rules, "保存したルールと同じ");
    assert.deepEqual(await savedRules(), { version: 1, rules }, "書き出しで、保存したルールは変わらない");
    assert.deepEqual(p.__errors, [], "ページのエラーは無い");
  } finally { await p.close(); }
});

test("T-CR-45 Pro でないとき (お試しの終わり): 案内が出て、追加・編集・保存・読み込み・有効の切り替えは disabled。書き出しと削除は使える (削除すると proCustomRules から消える)。Pro に戻ると、すべて操作できる", async () => {
  await setRules([WORDS_RULE, REGEX_RULE]);
  try {
    // 開いている画面が、お試しの終わりに追いつく (storage の変化で出し直す)。書き出しと削除は、そのときも使えるまま
    const live = await openCard();
    try {
      await waitRows(live, 2);
      await live.waitForFunction(() => document.getElementById("cr-save").disabled === false, null, { timeout: 5000 });
      assert.equal(await setInstalledAt(Date.now() - 8 * DAY), false, "お試しが終わり、無料版になる");
      await live.waitForFunction(() => document.getElementById("cr-save").disabled === true, null, { timeout: 8000 });
      assert.equal(await live.isVisible("#cr-pro-note"), true);
      assert.equal(await live.isDisabled("#cr-export"), false, "開いている画面でも、書き出しは使えるまま");
      assert.equal(await row(live, 0).locator(".cr-delete").isDisabled(), false, "開いている画面でも、削除は使えるまま");
      assert.equal(await row(live, 0).locator(".switch input").isDisabled(), true, "有効の切り替えは止まる");
    } finally { await live.close(); }

    // 無料版になってから開く: 一覧は、読むだけの形で出る
    const p = await openCard();
    try {
      assert.equal(await p.isVisible("#cr-pro-note"), true, "案内が出る");
      assert.equal((await p.textContent("#cr-pro-note")).trim(), NOTE_NOT_PRO);
      await waitRows(p, 2);
      // 足す・変える操作は止まる (フォーム・保存・読み込み・有効の切り替え・編集)
      for (const id of ["cr-kind", "cr-label", "cr-pattern", "cr-ignore-case", "cr-words", "cr-match", "cr-save", "cr-cancel", "cr-import"]) {
        assert.equal(await p.isDisabled(`#${id}`), true, `${id} は disabled`);
      }
      for (const i of [0, 1]) {
        for (const sel of [".switch input", ".cr-edit"]) {
          assert.equal(await row(p, i).locator(sel).isDisabled(), true, `一覧 ${i + 1} 行目の ${sel} は disabled`);
        }
        assert.equal(await row(p, i).locator(".cr-delete").isDisabled(), false, `一覧 ${i + 1} 行目の削除は使える`);
      }
      assert.equal(await p.isDisabled("#cr-export"), false, "書き出しは使える");
      assert.deepEqual(await savedRules(), { version: 1, rules: [WORDS_RULE, REGEX_RULE] }, "保存したルールは残っている");

      // 書き出しは、Pro でなくてもできる (自分のデータを持ち出せる)
      const [download] = await Promise.all([p.waitForEvent("download", { timeout: 10000 }), p.click("#cr-export")]);
      assert.equal(download.suggestedFilename(), EXPORT_FILE);
      assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(), "utf8")).rules, [WORDS_RULE, REGEX_RULE]);

      // 削除も、Pro でなくてもできる: 確認を取り消せば残り、受ければ proCustomRules から消える
      p.once("dialog", (d) => d.dismiss());
      await row(p, 0).locator(".cr-delete").click();
      await sleep(500);
      assert.equal((await savedRules()).rules.length, 2, "確認を取り消すと消えない");
      p.once("dialog", (d) => d.accept());
      await row(p, 0).locator(".cr-delete").click();
      await waitRows(p, 1);
      assert.deepEqual(await savedRules(), { version: 1, rules: [REGEX_RULE] }, "削除すると proCustomRules から消える");
      // 残った行は、読むだけのまま (削除だけ使える)
      assert.equal(await row(p, 0).locator(".switch input").isDisabled(), true);
      assert.equal(await row(p, 0).locator(".cr-edit").isDisabled(), true);
      p.once("dialog", (d) => d.accept());
      await row(p, 0).locator(".cr-delete").click();
      await waitRows(p, 0);
      assert.deepEqual(await savedRules(), { version: 1, rules: [] }, "最後の 1 本も消せる");
      assert.equal(await p.isDisabled("#cr-save"), true, "消したあとも、足す操作は止まったまま");
    } finally { await p.close(); }

    // Pro に戻ると、案内が消えて、すべて操作できる
    assert.equal(await setInstalledAt(Date.now()), true, "お試しに戻る");
    const q = await openCard();
    try {
      assert.equal(await q.isVisible("#cr-pro-note"), false);
      for (const id of ["cr-save", "cr-import", "cr-export", "cr-kind", "cr-label", "cr-words", "cr-match"]) {
        assert.equal(await q.isDisabled(`#${id}`), false, `${id} は使える`);
      }
    } finally { await q.close(); }
  } finally {
    await setInstalledAt(Date.now()); // どこで落ちても、お試しに戻す (このあとのテストは Pro で動く)
  }
});

test("T-CR-47 固まる正規表現 (validateRule を通り、stressTest が止まらない形): 保存は画面が固まらずに「時間がかかりすぎる正規表現です」で断り、読み込みは 1 本だけ断って残りを続ける", async () => {
  await setRules(null);
  const p = await openCard();
  try {
    // 1 秒ごとの見張りは Worker 側に置いてある。画面のスレッドは、そのあいだも動く (動かなければ、拍動の間隔が開く)
    await p.evaluate(() => {
      window.__beats = [];
      window.__beatTimer = setInterval(() => window.__beats.push(performance.now()), 50);
    });
    await fillRegex(p, { label: "HANG", pattern: HANG_PATTERN });
    const t0 = Date.now();
    await save(p);
    await p.waitForFunction((r) => document.getElementById("cr-errors").textContent.includes(r), TIMEOUT_REASON, { timeout: 10000 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 6000, `1 秒の見張りで打ち切る (実際は ${elapsed} ミリ秒)`);
    const gaps = await p.evaluate(() => {
      clearInterval(window.__beatTimer);
      const b = window.__beats;
      return b.slice(1).map((t, i) => t - b[i]);
    });
    assert.ok(gaps.length > 5, "待つあいだ、画面のスレッドが動いていた");
    assert.ok(Math.max(...gaps) < 900, `画面が固まっていない (拍動の最大の間隔 ${Math.round(Math.max(...gaps))} ミリ秒。固まれば、1 秒の見張りより長く止まる)`);
    assert.equal(await savedRules(), undefined, "保存されていない");
    assert.equal(await p.isDisabled("#cr-save"), false, "断ったあと、また保存を押せる");

    // 断ったあとも、Worker は作り直されて、ふつうのルールは保存できる
    await fillRegex(p, { label: "ACME_ID", pattern: "ACME-\\d{4}" });
    await save(p);
    await waitRows(p, 1);
    assert.deepEqual(await errorLines(p), []);

    // 読み込み: 固まる 1 本を挟んだファイルで、その 1 本だけを「読み込めなかったもの」にして、前後は足す
    const file = fileOf([
      { id: "f1", label: "PROJECT", kind: "words", words: ["アルファ計画"], match: "exact", enabled: true },
      { id: "f2", label: "HANG", kind: "regex", pattern: HANG_PATTERN, enabled: true },
      { id: "f3", label: "ORDER", kind: "regex", pattern: "ORD-\\d{4}", enabled: true },
    ]);
    const t1 = Date.now();
    const result = await importText(p, file, "追加 2 件、同じルール 0 件、読み込めなかったもの 1 件");
    assert.ok(Date.now() - t1 < 8000, "読み込み全体ではなく、固まった 1 本が 1 秒で打ち切られる");
    assert.match(result, /2 件目/);
    assert.ok(result.includes(TIMEOUT_REASON), "時間切れも理由つきで断る");
    const labels = (await savedRules()).rules.map((r) => r.label);
    assert.deepEqual(labels, ["ACME_ID", "PROJECT", "ORDER"], "前後の 2 本は足され、固まった 1 本は足されない");
    assert.deepEqual(p.__errors, [], "ページのエラーは無い");
  } finally { await p.close(); }
});

test("T-CR-51 確かめの Worker を使えないとき: 確かめずには保存も読み込みもしない (理由が出て、今のルールは変わらない。あとで押し直せる)", async () => {
  await setRules([WORDS_RULE]);
  const p = await openCard();
  try {
    await waitRows(p, 1);
    // Worker を立てようとすると失敗するようにする (拡張機能のファイルを読めない、などを真似る)。確かめずに保存すると、
    // 固まる正規表現が通り抜けて、送るたびに AI のサイトのページが固まりうるため、ここは止める側に倒す
    await p.evaluate(() => { window.Worker = function () { throw new Error("Worker を立てられない"); }; });
    await fillRegex(p, { label: "ACME_ID", pattern: "ACME-\\d{4}" });
    await save(p);
    await p.waitForFunction(() => document.getElementById("cr-errors").textContent.includes("確かめる処理を始められませんでした"), null, { timeout: 8000 });
    assert.deepEqual(await savedRules(), { version: 1, rules: [WORDS_RULE] }, "確かめずには保存しない");
    assert.equal(await p.isDisabled("#cr-save"), false, "断ったあと、また押せる");

    const result = await importText(p, fileOf([{ id: "in-1", label: "ACME_ID", kind: "regex", pattern: "ACME-\\d{4}", enabled: true }]), "確かめる処理を始められませんでした");
    assert.doesNotMatch(result, /追加 \d+ 件/, "確かめずには足さない");
    assert.deepEqual(await savedRules(), { version: 1, rules: [WORDS_RULE] }, "読み込みでも、今のルールは変わらない");
  } finally { await p.close(); }
});

test("T-CR-48 一覧の操作: 有効の切り替え・編集 (id と有効の状態を保つ)・編集をやめる・削除 (確認を取り消せる)。別の画面で変えると、開いている一覧にも出る", async () => {
  await setRules([WORDS_RULE, REGEX_RULE]);
  const p = await openCard();
  try {
    await waitRows(p, 2);
    assert.match((await rowTexts(p))[0], /PROJECT.*単語リスト|単語リスト.*PROJECT/s);
    assert.match((await rowTexts(p))[1], /ACME_ID/);
    assert.match((await rowTexts(p))[1], /正規表現/);

    // 有効の切り替え
    await row(p, 0).locator(".switch").click();
    await waitStored(() => savedRules().then((s) => s.rules[0].enabled === false));
    assert.equal((await savedRules()).rules[1].enabled, true, "ほかのルールは変わらない");
    await row(p, 0).locator(".switch").click();
    await waitStored(() => savedRules().then((s) => s.rules[0].enabled === true));

    // 編集: フォームに入り、直して保存すると、同じ id・同じ有効の状態のまま変わる
    await row(p, 1).locator(".cr-edit").click();
    assert.equal(await p.inputValue("#cr-kind"), "regex");
    assert.equal(await p.inputValue("#cr-label"), "ACME_ID");
    assert.equal(await p.inputValue("#cr-pattern"), "ACME-\\d{4}");
    await p.fill("#cr-pattern", "ACME-\\d{6}");
    await save(p);
    await waitStored(() => savedRules().then((s) => s.rules[1].pattern === "ACME-\\d{6}"));
    const edited = (await savedRules()).rules;
    assert.equal(edited.length, 2, "増えない");
    assert.equal(edited[1].id, REGEX_RULE.id, "id は同じ");
    assert.equal(edited[1].enabled, true);
    await waitSaved(p);
    assert.equal(await p.inputValue("#cr-pattern"), "", "保存したあと、フォームは空に戻る");

    // 編集をやめる: 保存されず、フォームは空に戻る
    await row(p, 0).locator(".cr-edit").click();
    assert.equal(await p.inputValue("#cr-label"), "PROJECT");
    assert.match(await p.inputValue("#cr-words"), /アルファ計画/);
    await p.click("#cr-cancel");
    assert.equal(await p.inputValue("#cr-words"), "");
    assert.deepEqual((await savedRules()).rules[0], WORDS_RULE, "やめた編集は保存されない");

    // 削除: 確認を取り消せば残り、受ければ消える
    p.once("dialog", (d) => d.dismiss());
    await row(p, 0).locator(".cr-delete").click();
    await sleep(500);
    assert.equal((await savedRules()).rules.length, 2, "確認を取り消すと消えない");

    // 別の行を編集しているあいだに、先の行を消しても、編集は続けられる (消した分、位置が動くのを追いかける)
    await row(p, 1).locator(".cr-edit").click();
    p.once("dialog", (d) => d.accept());
    await row(p, 0).locator(".cr-delete").click();
    await waitRows(p, 1);
    assert.deepEqual((await savedRules()).rules.map((r) => r.id), [REGEX_RULE.id], "確認を受けると消える");
    assert.equal(await p.inputValue("#cr-label"), "ACME_ID", "編集は続いている");
    await p.fill("#cr-pattern", "ACME-\\d{8}");
    await save(p);
    await waitStored(() => savedRules().then((s) => s.rules.length === 1 && s.rules[0].pattern === "ACME-\\d{8}"));
    assert.equal((await savedRules()).rules[0].id, REGEX_RULE.id, "動いた位置のルールが、同じ id のまま直る");
    await waitSaved(p);

    // 別の画面 (storage の書き換え) で変えると、開いている一覧が追いつく
    await setRules([WORDS_RULE, REGEX_RULE, { ...WORDS_RULE, id: "r-3", label: "THIRD" }]);
    await waitRows(p, 3);
    assert.match((await rowTexts(p))[2], /THIRD/);
    assert.deepEqual(p.__errors, [], "ページのエラーは無い");
  } finally { await p.close(); }
});

test("T-CR-49 効いていない保存済みのルール: 一覧に印と理由が出る。名前や中身に HTML があっても、文字として出る (要素は増えない)", async () => {
  const HOSTILE = '<img src=x onerror="window.__xss=1">';
  await setRules([
    WORDS_RULE,
    { id: "off", label: "DISABLED_ONE", kind: "words", words: ["ベータ計画"], match: "exact", enabled: false },
    { id: "bad-name", label: "lowercase", kind: "words", words: ["アルファ計画"], match: "exact", enabled: true },
    { id: "bad-html", label: HOSTILE, kind: "regex", pattern: "<b>x</b>", enabled: true },
    "not-an-object",
  ]);
  const p = await openCard();
  try {
    await waitRows(p, 5);
    // 検査の答えが届いて、印が付くまで待つ
    await p.waitForFunction(() => document.querySelectorAll("#cr-list .cr-item .cr-unused").length === 3, null, { timeout: 8000 });
    const texts = await rowTexts(p);
    assert.doesNotMatch(texts[0], /使われていません/, "正しいルールに印は付かない");
    assert.doesNotMatch(texts[1], /使われていません/, "オフにしただけのルールにも、印は付かない");
    assert.match(texts[2], /このルールは使われていません: .*伏せ字の名前は英大文字で始め/s);
    assert.match(texts[3], /このルールは使われていません/);
    assert.match(texts[4], /このルールは使われていません/);
    assert.equal(await row(p, 1).locator(".switch input").isChecked(), false, "オフのルールは、切り替えがオフ");

    // 名前に入っていた HTML は、文字として出る
    assert.ok(texts[3].includes(HOSTILE), "名前がそのまま文字で出る");
    assert.equal(await p.locator("#cr-list img").count(), 0, "img の要素は増えない");
    assert.equal(await p.locator("#cr-list b").count(), 0, "b の要素は増えない");
    assert.equal(await p.evaluate(() => window.__xss), undefined, "スクリプトは動かない");
    assert.deepEqual(p.__errors, [], "ページのエラーは無い");
  } finally { await p.close(); }
});

test("T-CR-50 完全一致で語の端がひらがなのとき: 「この語は部分一致の方が向いています」と案内が出る。保存は止めない。部分一致に替えると消える", async () => {
  await setRules(null);
  const p = await openCard();
  try {
    const advice = () => p.evaluate(() => { const el = document.getElementById("cr-advice"); return el && !el.hidden ? el.textContent : ""; });
    await p.selectOption("#cr-kind", "words");
    await p.selectOption("#cr-match", "exact");
    await p.fill("#cr-words", "アルファ計画\n山田商事");
    assert.equal(await advice(), "", "端がひらがなの語が無ければ、案内は出ない");
    await p.fill("#cr-words", "アルファ計画\nお客様");
    assert.match(await advice(), /この語は部分一致の方が向いています/, "先頭がひらがな");
    await p.fill("#cr-words", "山田さん");
    assert.match(await advice(), /「山田さん」/, "終わりがひらがな。どの語かが分かる");
    assert.match(await advice(), /この語は部分一致の方が向いています/);
    await p.fill("#cr-words", "アルファー");
    assert.equal(await advice(), "", "ー はカタカナの仲間 (完全一致の文字の種類)。ひらがなではない");
    await p.fill("#cr-words", "山田さん");
    await p.selectOption("#cr-match", "partial");
    assert.equal(await advice(), "", "部分一致なら、案内は出ない");
    await p.selectOption("#cr-match", "exact");
    assert.match(await advice(), /この語は部分一致の方が向いています/);
    assert.deepEqual(await errorLines(p), [], "案内は cr-errors には出ない");

    // 案内は保存を止めない
    await fillWords(p, { label: "CUSTOMER", words: ["山田さん"], match: "exact" });
    await save(p);
    await waitRows(p, 1);
    assert.deepEqual((await savedRules()).rules[0].words, ["山田さん"]);
    assert.deepEqual(p.__errors, [], "ページのエラーは無い");
  } finally { await p.close(); }
});

test("T-CR-56 編集の保存: 確かめ (Worker) を待つあいだに別の画面がそのルールを変えたら、新しいルールとして足さずに断る (追加か編集かは、確かめに出す前に決める)", async () => {
  await setRules([WORDS_RULE, REGEX_RULE]);
  const p = await openCard();
  try {
    await waitRows(p, 2);
    await row(p, 1).locator(".cr-edit").click();
    await p.fill("#cr-pattern", "ACME-\\d{6}");
    // 確かめの頼み (check) を Worker に渡す前に、別の画面がこのルールを変える (storage の書き換え)。開いている一覧が
    // 出し直されて編集が終わる (「編集をやめました」) のを待ってから、頼みを渡す
    const changed = [WORDS_RULE, { ...REGEX_RULE, pattern: "ACME-\\d{5}" }];
    await p.evaluate((rules) => {
      const RealWorker = window.Worker;
      window.Worker = class extends RealWorker {
        postMessage(message) {
          if (!message || message.op !== "check") return super.postMessage(message);
          chrome.storage.local.set({ proCustomRules: { version: 1, rules } }).then(async () => {
            for (let i = 0; i < 50 && !document.getElementById("cr-status").textContent.includes("編集をやめました"); i++) {
              await new Promise((r) => setTimeout(r, 10));
            }
            super.postMessage(message);
          });
          return undefined;
        }
      };
    }, changed);
    await save(p);
    const outcome = await p.waitForFunction(() => {
      if (document.getElementById("cr-errors").textContent.includes("ほかの画面でルールが変わっていたため")) return "refused";
      return document.getElementById("cr-status").textContent === "保存しました" ? "saved" : null;
    }, null, { timeout: 8000 });
    assert.equal(await outcome.jsonValue(), "refused", "編集していたルールが変わっていたら、保存せずに断る");
    assert.deepEqual((await savedRules()).rules, changed, "別の画面の変更が残り、同じ id のルールが新しく足されない");
    assert.deepEqual(p.__errors, [], "ページのエラーは無い");
  } finally { await p.close(); }
});
