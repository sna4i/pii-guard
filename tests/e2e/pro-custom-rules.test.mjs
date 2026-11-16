// tests/e2e/pro-custom-rules.test.mjs — Pro のカスタムルールが、送る経路のすべて (ページの送信・ChatGPT の保護入力欄・
// 添付) で効き、時間内に調べきれなかったときは必ず確認に回る (Pro Phase 2 の設計 (P1)、T-CR-31〜40)
//
// 土台は tests/fixtures/pro-ext.mjs の launchPro (拡張機能の写し + 模擬の ExtensionPay。入れた直後はお試しの Pro)。
// 模擬の ChatGPT と、模擬の Claude・Gemini (mock-sites/server.mjs) に向ける。ルールの値は架空のものだけ。
// ページの送信は、確認を出さない設定 (interactive: false) で伏せ字のまま届くかを見る。
// 時間切れは、E2E のときだけの上書き (__pii_guard_e2e_custom_budget_ms) で上限を 0 ミリ秒にして起こす。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchPro, API_KEY } from "../fixtures/pro-ext.mjs";
import { startMockLlm } from "../fixtures/mock-chatgpt/server.mjs";

const RULES = [{ id: "r1", label: "PROJECT", kind: "words", words: ["アルファ計画"], match: "exact", enabled: true },
               { id: "r2", label: "ACME_ID", kind: "regex", pattern: "ACME-\\d{4}", enabled: true }];
const TEXT = "アルファ計画は ACME-1234 で管理しています";
const MASKED = "<PROJECT_1>は <ACME_ID_1> で管理しています";
const FILE_NAME = "アルファ計画_議事録.txt";
const FILE_TEXT = "アルファ計画の議事録\n管理番号 ACME-1234\n";
const NOTICE = /カスタムルールの一部を時間内に調べきれませんでした/;
const BUDGET_KEY = "__pii_guard_e2e_custom_budget_ms";
// 確認を出さない設定 (サイドバーもモーダルも出さずに伏せ字で送る)。開くたびにこの値に戻す
const BASE = {
  enabled: true, interactive: false, uiMode: "sidebar", maskAllowlist: [], maskForceList: [],
  piiSendWarning: true, secureComposerEnabled: true, proCustomRules: { version: 1, rules: RULES },
};
const SIDEBAR = 'div[data-pii-guard="sidebar"]';
const DAY = 24 * 3600 * 1000;

let h;
let pay;
let close;
let S; // sites-harness.mjs の道具 (ブラウザは launchPro のものを使う。ハーネスより先に写しを作るので、あとから読み込む)
before(async () => {
  ({ h, pay, close } = await launchPro({ mockSites: true, storage: { proCustomRules: { version: 1, rules: RULES } } }));
  S = await import("../fixtures/sites-harness.mjs");
});
after(async () => {
  if (close) await close();
});

const td = new TextDecoder();
const SITES = {
  claude: {
    url: "https://claude.ai/new", editor: ".ProseMirror", file: "#cl-file",
    sent: (since) => h.sites.byKind("claude-rpc", since).map((r) => { const v = S.EG.getAtPath(new Uint8Array(r.bytes), [2, 3]); return v ? td.decode(v) : null; }),
  },
  gemini: {
    url: "https://gemini.google.com/app", editor: "rich-textarea .ql-editor",
    sent: (since) => h.sites.byKind("gemini-session", since).map((r) => { const wc = S.EG.parseWebChannelForm(r.body); const v = wc && S.EG.getAtPath(wc.items[0].bytes, [2, 9, 1]); return v ? td.decode(v) : null; }),
  },
};

// pill: false なら、入力欄のアイコンを待たない (開いた直後に送るため。送信と添付の見張りは、読み込みの最初から動いている)
async function openSite(site, storage = {}, { pill = true } = {}) {
  await h.setStorage({ ...BASE, ...storage });
  const p = await h.openSite(SITES[site].url);
  if (pill) await S.waitPill(p);
  return p;
}
// Pro かどうかの答えを、返した関数を呼ぶまで止める。ページを開いた直後の「保存したルールは読んだが、Pro かどうかの
// 答えがまだで、エンジンに渡せていない」あいだを作るため (このあいだに伏せる道が動くと、ルールが効かないまま送る)。
// ExtPay は API キーがあるときだけ extensionpay.com に問い合わせ、Service Worker はキャッシュ (licenseState) が
// 無いときだけ、その答えを待ってから返す。渡し終えるのを待つ上限 (3 秒) より十分に前に、呼んで止めを外すこと
async function holdProAnswer() {
  let open = () => {};
  pay.state.gate = new Promise((r) => { open = r; });
  await h.ext.evaluate((k) => chrome.storage.sync.set({ extensionpay_api_key: k }), API_KEY);
  await h.ext.evaluate(() => chrome.storage.local.remove("licenseState"));
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    pay.state.gate = null;
    open();
    // 答えが届いてキャッシュに残ってから、API キーを外す (ほかのテストは、キャッシュの答えで動く)
    for (let i = 0; i < 50; i++) { if ((await h.getStorage(["licenseState"])).licenseState) break; await S.sleep(100); }
    await h.ext.evaluate(() => chrome.storage.sync.remove("extensionpay_api_key"));
  };
}
// ページの世界に配られた設定が want の値になるまで待つ
function waitSettings(p, want, ms = 8000) {
  return p.waitForFunction((w) => {
    const s = window.__localMaskMCP && window.__localMaskMCP.settings;
    return !!s && Object.keys(w).every((k) => s[k] === w[k]);
  }, want, { timeout: ms });
}
async function send(p, site, text) {
  await p.click(SITES[site].editor);
  await p.keyboard.type(text, { delay: 2 });
  await S.sleep(500);
  await p.keyboard.press("Enter");
}
// 打つのを待たずに、すぐ送る (開いた直後のあいだに送るため)
async function sendNow(p, site, text) {
  await p.click(SITES[site].editor);
  await p.keyboard.insertText(text);
  await p.keyboard.press("Enter");
}
async function waitSent(site, since, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = SITES[site].sent(since);
    if (got.length) return got;
    await S.sleep(100);
  }
  return SITES[site].sent(since);
}
const chatSent = () => {
  const conv = h.server.byKind("conversation");
  return conv.length ? JSON.parse(conv[conv.length - 1].body).messages[0].content.parts.join("") : null;
};
const attached = (p) => p.evaluate(() => QA.events.filter((e) => e.type === "attached"));
async function waitAttached(p, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = await attached(p);
    if (got.length) return got[got.length - 1];
    await S.sleep(100);
  }
  return null;
}
const sidebarNotice = (p) => p.evaluate((sel) => {
  const host = document.querySelector(sel);
  const n = host && host.shadowRoot && host.shadowRoot.querySelector(".notice");
  return n ? n.textContent : null;
}, SIDEBAR);
// お試しの始まり (ExtPay が覚えているインストールの日時) を替えて確かめ直し、Pro かどうかを返す
async function setInstalledAt(ms) {
  await h.ext.evaluate((t) => chrome.storage.sync.set({ extensionpay_installed_at: new Date(t).toISOString() }), ms);
  const s = await h.ext.evaluate(() => chrome.runtime.sendMessage({ type: "license:get", refresh: true }));
  return s.pro;
}
// 動作ログで、code の記録のうち d が want に合うものの回数 (同じ記録は 1 行にまとめられ、n が増える)
async function logCount(code, want) {
  const rows = await h.ext.evaluate(async (c) => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((k) => k.startsWith("diagLog:")).flatMap((k) => all[k]).filter((e) => e && e.code === c);
  }, code);
  return rows.filter((e) => e.d && Object.keys(want).every((k) => e.d[k] === want[k])).reduce((n, e) => n + (e.n || 1), 0);
}
// その回数が before より増えるまで待つ (Service Worker がまとめて書く)。増えたら true
async function waitLogAbove(code, want, before, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await logCount(code, want)) > before) return true;
    await S.sleep(200);
  }
  return false;
}
const removeBudget = () => h.ext.evaluate((k) => chrome.storage.local.remove(k), BUDGET_KEY);
// サイドバーで、LLM の答えが出そろってから (伏せる候補が並び、LLM の待ちの表示が消えてから) 送るを押す
async function confirmAfterLlm(p) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const ready = await p.evaluate((sel) => {
      const sr = document.querySelector(sel) && document.querySelector(sel).shadowRoot;
      return !!(sr && sr.querySelectorAll(".row").length > 0 && !sr.querySelector(".llm-overlay"));
    }, SIDEBAR);
    if (ready) break;
    await S.sleep(100);
  }
  assert.ok(await S.clickInShadow(p, SIDEBAR, /マスクして送信/), "LLM の答えが出てから、送るを押せる");
}
// 答えを止めたまま、渡し終えるのを待つ上限 (3 秒) を過ぎるまで待つ
const PAST_WAIT_MS = 3500;

test("T-CR-31 Claude と Gemini (模擬): 本文の アルファ計画 と ACME-1234 が、届いた文で <PROJECT_1> と <ACME_ID_1> になる", async () => {
  // Claude は、ページを開いた直後 (ルールは読んだが、Pro かどうかの答えがまだで、エンジンに渡せていないあいだ) に送る。
  // ISOLATED world は渡し終えるまで伏せずに待ち、渡し終えてから伏せる
  const release = await holdProAnswer();
  try {
    const p = await openSite("claude", {}, { pill: false });
    try {
      const t0 = Date.now();
      await sendNow(p, "claude", TEXT);
      await S.sleep(500);
      assert.equal(SITES.claude.sent(t0).length, 0, "claude: ルールを渡し終えるまでは送らない");
      await release();
      assert.deepEqual(await waitSent("claude", t0), [MASKED], "claude: 届いた文");
    } finally { await p.close(); }
  } finally { await release(); }

  const g = await openSite("gemini");
  try {
    const t0 = Date.now();
    await send(g, "gemini", TEXT);
    assert.deepEqual(await waitSent("gemini", t0), [MASKED], "gemini: 届いた文");
  } finally { await g.close(); }
});

test("T-CR-32 ChatGPT の保護入力欄: 届いた文で伏せられている", async () => {
  await h.setStorage(BASE);
  h.server.clear();
  // 保護入力欄が立ち上がった直後 (ルールをエンジンに渡せていないあいだ) に送る。渡し終えるまで伏せずに待つ
  const release = await holdProAnswer();
  try {
    const page = await h.openChat("/");
    try {
      const frame = await h.waitSecureReady(page, 10000);
      assert.ok(frame, "保護入力欄が立ち上がる");
      await h.type(page, frame, TEXT);
      await h.enterNoConfirm(page, frame);
      await S.sleep(500);
      assert.equal(h.server.byKind("conversation").length, 0, "ルールを渡し終えるまでは送らない");
      await release();
      await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 5000 }); // 見つかった 2 件の確認
      await frame.click("#confirm-send");
      await page.waitForFunction(() => window.__mock.events.some((e) => e.type === "conversation-ok"), null, { timeout: 10000 });
      assert.equal(chatSent(), MASKED);
    } finally { await page.close(); }
  } finally { await release(); }
});

test("T-CR-33 添付: テキストのファイルの中身と、名前「アルファ計画_議事録.txt」が伏せられる", async () => {
  // ページを開いた直後 (ルールをエンジンに渡せていないあいだ) に添付する。添付の見張りは渡し終えるまで伏せずに待つ
  const release = await holdProAnswer();
  try {
    const p = await openSite("claude", {}, { pill: false });
    try {
      const dialogs = [];
      p.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
      await p.setInputFiles(SITES.claude.file, { name: FILE_NAME, mimeType: "text/plain", buffer: Buffer.from(FILE_TEXT, "utf8") });
      await S.sleep(500);
      assert.equal((await attached(p)).length, 0, "ルールを渡し終えるまでは、ページに渡さない");
      await release();
      const att = await waitAttached(p);
      assert.ok(att, "ページに添付が渡る");
      assert.deepEqual(att.names, ["[PROJECT_1]_議事録.txt"], "ファイル名 (伏せ字の < > は [ ] になる)");
      assert.deepEqual(att.texts, ["<PROJECT_1>の議事録\n管理番号 <ACME_ID_1>\n"], "中身");
      assert.deepEqual(dialogs, [], "伏せられた添付では、確認は出ない");
    } finally { await p.close(); }
  } finally { await release(); }
});

test("T-CR-34 ページの世界から読めない: window.__localMaskMCP.settings にルールの語と正規表現が無く、hasSecretLists は true", async () => {
  const p = await openSite("claude");
  try {
    await waitSettings(p, { pro: true, hasSecretLists: true });
    const seen = await p.evaluate(() => {
      const NS = window.__localMaskMCP;
      return { settings: JSON.stringify(NS.settings), count: NS.engine.getCustomRuleCount(), customRules: typeof NS.engine.customRules };
    });
    for (const s of ["アルファ計画", "ACME", "PROJECT"]) assert.ok(!seen.settings.includes(s), `settings に ${s} が無い (${seen.settings})`);
    assert.equal(seen.count, 0, "ページの世界のエンジンは、ルールを持たない");
    assert.equal(seen.customRules, "undefined", "ページの世界は、ルールの部品 (custom-rules.js) を読まない");
  } finally { await p.close(); }
});

test("T-CR-35 開いているタブ: ルールを足すと (storage の書き換え)、同じタブの次の送信から効く", async () => {
  const p = await openSite("claude", { proCustomRules: { version: 1, rules: [] } });
  try {
    await waitSettings(p, { pro: true, hasSecretLists: false });
    let t0 = Date.now();
    await send(p, "claude", TEXT);
    assert.deepEqual(await waitSent("claude", t0), [TEXT], "ルールが無いあいだは、原文のまま届く");
    await h.setStorage({ proCustomRules: { version: 1, rules: RULES } });
    await waitSettings(p, { hasSecretLists: true });
    t0 = Date.now();
    await send(p, "claude", TEXT);
    assert.deepEqual(await waitSent("claude", t0), [MASKED], "足したルールが、同じタブの次の送信から効く");
    // 外したときも、同じタブの次の送信から効かなくなる
    await h.setStorage({ proCustomRules: { version: 1, rules: [] } });
    await waitSettings(p, { hasSecretLists: false });
    t0 = Date.now();
    await send(p, "claude", TEXT);
    assert.deepEqual(await waitSent("claude", t0), [TEXT], "外したルールは、同じタブの次の送信から効かない");
  } finally { await p.close(); }
});

test("T-CR-36 Pro が切れる (お試しの終わり): ルールが残っていても、アルファ計画 は原文のまま届き、hasSecretLists は false。ほかの検出は今どおり", async () => {
  try {
    const p = await openSite("claude");
    try {
      await waitSettings(p, { pro: true, hasSecretLists: true });
      assert.equal(await setInstalledAt(Date.now() - 8 * DAY), false, "お試しが終わり、無料版になる");
      await waitSettings(p, { pro: false, hasSecretLists: false });
      const t0 = Date.now();
      await send(p, "claude", `${TEXT}。連絡先は 090-1234-5678`);
      assert.deepEqual(await waitSent("claude", t0), [`${TEXT}。連絡先は <PHONE_NUMBER_1>`], "ルールの語は原文のまま、電話番号は今どおり伏せる");
      assert.deepEqual((await h.getStorage(["proCustomRules"])).proCustomRules, { version: 1, rules: RULES }, "ルールは残っている");
    } finally { await p.close(); }

    // 逆の向き: 無料版のときに開いたタブで Pro に戻る (購入など)。残っていたルールが、同じタブの次の送信から効く
    const q = await openSite("claude");
    try {
      let t0 = Date.now();
      await send(q, "claude", TEXT); // 1 回目の送信で、このタブが無料版の答えを受け取り終えている
      assert.deepEqual(await waitSent("claude", t0), [TEXT], "無料版のあいだは原文のまま");
      assert.equal(await setInstalledAt(Date.now()), true, "お試しに戻る");
      await waitSettings(q, { pro: true, hasSecretLists: true });
      t0 = Date.now();
      await send(q, "claude", TEXT);
      assert.deepEqual(await waitSent("claude", t0), [MASKED], "Pro に戻ると、同じタブの次の送信から効く");
    } finally { await q.close(); }
  } finally {
    await setInstalledAt(Date.now()); // どこで落ちても、お試しに戻す (このあとのテストは Pro で動く)
  }
});

test("T-CR-37 時間切れ (上書きで 0 ミリ秒): 確認を出さない設定でも、Claude ではサイドバーが開いて「カスタムルールの一部を時間内に調べきれませんでした」が出る。ChatGPT では保護入力欄の確認が出る", async () => {
  const text = "アルファ計画の件で相談です"; // ほかの検出が無い文 (時間切れだけで確認に回るか)
  try {
    // 確認を出さない設定 (interactive: false) でも、確認を出す設定で伏せる候補が 0 件のとき (ふだんは確認なしで送る) も、
    // サイドバーに回る
    for (const interactive of [false, true]) {
      const p = await openSite("claude", { [BUDGET_KEY]: 0, piiSendWarning: false, interactive });
      try {
        const logged = await logCount("custom.partial", { via: "page" });
        const t0 = Date.now();
        await send(p, "claude", text);
        assert.ok(await S.waitSidebar(p), `サイドバーが開く (interactive: ${interactive})`);
        assert.match(String(await sidebarNotice(p)), NOTICE);
        assert.equal(SITES.claude.sent(t0).length, 0, "確かめる前は届かない");
        assert.ok(await waitLogAbove("custom.partial", { via: "page" }, logged), "動作ログに残る (page)");
        assert.ok(await S.clickInShadow(p, SIDEBAR, /キャンセル/), "キャンセルを押せる");
        await S.sleep(400);
        assert.equal(SITES.claude.sent(t0).length, 0, "キャンセルすると届かない");
      } finally { await p.close(); }
    }

    // 確認の方式がモーダルなら、モーダルに回る (同値分割: サイドバー / モーダル)
    const m = await openSite("claude", { [BUDGET_KEY]: 0, piiSendWarning: false, uiMode: "modal" });
    try {
      const t0 = Date.now();
      await send(m, "claude", text);
      const modalNotice = await m.waitForFunction(() => {
        const host = document.querySelector("div[data-mask-mcp-modal]");
        const n = host && host.shadowRoot && host.shadowRoot.querySelector(".notice");
        return n ? n.textContent : null;
      }, null, { timeout: 8000 });
      assert.match(await modalNotice.jsonValue(), NOTICE);
      assert.equal(await S.sidebarState(m), null, "サイドバーは出ない");
      assert.equal(SITES.claude.sent(t0).length, 0, "確かめる前は届かない");
      await m.evaluate(() => [...document.querySelector("div[data-mask-mcp-modal]").shadowRoot.querySelectorAll("button")].find((b) => b.dataset.action === "cancel").click());
      await S.sleep(400);
      assert.equal(SITES.claude.sent(t0).length, 0, "キャンセルすると届かない");
    } finally { await m.close(); }

    h.server.clear();
    const page = await h.openChat("/");
    try {
      const frame = await h.waitSecureReady(page, 10000);
      assert.ok(frame, "保護入力欄が立ち上がる");
      const logged = await logCount("custom.partial", { via: "secure-composer" });
      await h.type(page, frame, text);
      await h.enterNoConfirm(page, frame);
      await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 5000 });
      assert.match(await frame.textContent("#confirm-msg"), NOTICE);
      assert.equal(h.server.byKind("conversation").length, 0, "確かめる前は届かない");
      assert.ok(await waitLogAbove("custom.partial", { via: "secure-composer" }, logged), "動作ログに残る (secure-composer)");
      await frame.click("#confirm-cancel");
    } finally { await page.close(); }
  } finally {
    await removeBudget();
  }
});

test("T-CR-38 時間切れの添付: 今の「伏せられない添付」の確認 (dialog) が出る", async () => {
  try {
    const p = await openSite("claude", { [BUDGET_KEY]: 0 });
    try {
      const dialogs = [];
      p.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
      const logged = await logCount("custom.partial", { via: "attachment" });
      await p.setInputFiles(SITES.claude.file, { name: FILE_NAME, mimeType: "text/plain", buffer: Buffer.from(FILE_TEXT, "utf8") });
      for (let i = 0; i < 50 && !dialogs.length; i++) await S.sleep(100);
      assert.equal(dialogs.length, 1, "確認が出る");
      assert.match(dialogs[0], /伏せられません/);
      assert.ok(dialogs[0].includes(FILE_NAME), `確認にファイルの名前が出る (${dialogs[0]})`);
      await S.sleep(300);
      // 模擬の Claude は、渡されたファイルが 0 件でも change のたびに attached を残すので、ファイルの数で見る
      assert.equal((await attached(p)).reduce((n, e) => n + e.names.length, 0), 0, "キャンセルすると、ページにファイルが渡らない");
      assert.ok(await waitLogAbove("custom.partial", { via: "attachment" }, logged), "動作ログに残る (attachment)");
    } finally { await p.close(); }

    // 本文に入れて送る添付 (Claude の PerformAction の添付の欄) は、確認を出さずに送る前にもう一度伏せる。
    // そこで時間切れになったら、本文を確かめて送るを押しても、送らない
    await removeBudget();
    const q = await openSite("claude");
    try {
      await q.setInputFiles(SITES.claude.file, { name: FILE_NAME, mimeType: "text/plain", buffer: Buffer.from(FILE_TEXT, "utf8") });
      assert.ok(await waitAttached(q), "上限がふだんどおりのあいだは、伏せた添付がページに渡る");
      await h.setStorage({ [BUDGET_KEY]: 0 });
      const blocked = await logCount("send.blocked", { reason: "custom-rules-incomplete" });
      const t0 = Date.now();
      await send(q, "claude", "議事録を要約してください");
      assert.ok(await S.waitSidebar(q), "本文も時間切れなので、サイドバーが開く");
      assert.ok(await S.clickInShadow(q, SIDEBAR, /マスクして送信/), "送るを押せる");
      await S.sleep(800);
      assert.equal(h.sites.byKind("claude-rpc", t0).length, 0, "添付が時間切れなので、届かない");
      assert.ok(await waitLogAbove("send.blocked", { reason: "custom-rules-incomplete" }, blocked), "止めた理由が動作ログに残る");
    } finally { await q.close(); }
  } finally {
    await removeBudget();
  }
});

test("T-CR-39 LLM の置き換えモードを入れていても、カスタムルールが効いているあいだは置き換えを使わず、カスタムの語が伏せ字で届く", async () => {
  // 模擬の LLM (今の E2E の startMockLlm)。置き換えを頼まれると ACME-1234 だけを書き換え、アルファ計画 は残す
  // (ルールを知らない LLM の取りこぼし)。検出を頼まれたときは、足す検出なし
  const llm = await startMockLlm({
    reply: (body) => {
      const system = String((body && Array.isArray(body.messages) && body.messages[0] && body.messages[0].content) || "");
      return system.includes("rewritten_text")
        ? JSON.stringify({ rewritten_text: "(rewritten)", replacements: [{ original: "ACME-1234", replacement: "<code_1>", entity_type: "PROJECT_CODE" }] })
        : '{"entities":[]}';
    },
  });
  // 置き換えモードは、確認を出す設定のときだけ使われる
  const LLM = { interactive: true, localLlmEnabled: true, localLlmUrl: llm.url, localLlmModel: "qwen3:1.7b", localLlmKind: "ollama", localLlmMode: "replace" };
  try {
    // カスタムルールが効いている (Pro で、ルールがある): 置き換えを使わず、いつもの道 (カスタムルールあり) で伏せる
    const p = await openSite("claude", LLM);
    try {
      await waitSettings(p, { pro: true, hasSecretLists: true });
      const skipped = await logCount("llm.replace", { status: "skipped" });
      const t0 = Date.now();
      await send(p, "claude", TEXT);
      await confirmAfterLlm(p);
      assert.deepEqual(await waitSent("claude", t0), [MASKED], "カスタムの語も伏せ字で届く");
      assert.ok(await waitLogAbove("llm.replace", { status: "skipped" }, skipped), "置き換えを使わなかったことが動作ログに残る");
      assert.equal(await p.evaluate(() => window.__localMaskMCP.settings.customRulesActive), true, "ページの世界には、効いているかどうかだけが届く");
    } finally { await p.close(); }

    // 効いていない (ルールが無い): 置き換えモードは今どおり使う (LLM の書き換えがそのまま届く)
    const q = await openSite("claude", { ...LLM, proCustomRules: { version: 1, rules: [] } });
    try {
      await waitSettings(q, { pro: true, hasSecretLists: false });
      const t0 = Date.now();
      await send(q, "claude", TEXT);
      await confirmAfterLlm(q);
      assert.deepEqual(await waitSent("claude", t0), ["アルファ計画は <code_1> で管理しています"], "置き換えの結果が届く");
    } finally { await q.close(); }
  } finally {
    await h.ext.evaluate(() => chrome.storage.local.remove(["localLlmEnabled", "localLlmUrl", "localLlmModel", "localLlmKind", "localLlmMode"]));
    await llm.close();
  }
});

test("T-CR-40 ルールがあるのに Pro かどうか分からない (待つ上限を過ぎても答えが来ない) ときは、時間切れと同じく確認に回り、一文が出る。ルールが無ければ確認は出ない", async () => {
  const release = await holdProAnswer();
  try {
    // ページの送信 (確認を出さない設定): サイドバーが開き、一文が出る
    const p = await openSite("claude", {}, { pill: false });
    try {
      await S.sleep(PAST_WAIT_MS);
      const logged = await logCount("custom.partial", { via: "page" });
      const t0 = Date.now();
      await sendNow(p, "claude", TEXT);
      assert.ok(await S.waitSidebar(p), "ページの送信: サイドバーが開く");
      assert.match(String(await sidebarNotice(p)), NOTICE);
      assert.equal(SITES.claude.sent(t0).length, 0, "確かめる前は届かない");
      assert.ok(await waitLogAbove("custom.partial", { via: "page" }, logged), "動作ログに残る (page)");
      assert.ok(await S.clickInShadow(p, SIDEBAR, /キャンセル/), "キャンセルを押せる");
    } finally { await p.close(); }

    // 保護入力欄 (確認を出さない設定でも): 確認が出て、一文が見える
    await h.setStorage({ ...BASE, piiSendWarning: false });
    h.server.clear();
    const page = await h.openChat("/");
    try {
      const frame = await h.waitSecureReady(page, 10000);
      assert.ok(frame, "保護入力欄が立ち上がる");
      await S.sleep(PAST_WAIT_MS);
      const logged = await logCount("custom.partial", { via: "secure-composer" });
      await h.type(page, frame, TEXT);
      await h.enterNoConfirm(page, frame);
      await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 5000 });
      assert.match(await frame.textContent("#confirm-msg"), NOTICE);
      assert.equal(h.server.byKind("conversation").length, 0, "確かめる前は届かない");
      assert.ok(await waitLogAbove("custom.partial", { via: "secure-composer" }, logged), "動作ログに残る (secure-composer)");
      await frame.click("#confirm-cancel");
    } finally { await page.close(); }

    // 添付: 伏せられない添付の確認が出る
    const a = await openSite("claude", {}, { pill: false });
    try {
      const dialogs = [];
      a.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
      await S.sleep(PAST_WAIT_MS);
      const logged = await logCount("custom.partial", { via: "attachment" });
      await a.setInputFiles(SITES.claude.file, { name: FILE_NAME, mimeType: "text/plain", buffer: Buffer.from(FILE_TEXT, "utf8") });
      for (let i = 0; i < 50 && !dialogs.length; i++) await S.sleep(100);
      assert.equal(dialogs.length, 1, "添付: 確認が出る");
      assert.match(dialogs[0], /伏せられません/);
      await S.sleep(300);
      assert.equal((await attached(a)).reduce((n, e) => n + e.names.length, 0), 0, "キャンセルすると、ページにファイルが渡らない");
      assert.ok(await waitLogAbove("custom.partial", { via: "attachment" }, logged), "動作ログに残る (attachment)");
    } finally { await a.close(); }

    // ルールが無ければ、答えが来なくても今と同じ (確認は出ず、そのまま届く)
    const n = await openSite("claude", { proCustomRules: { version: 1, rules: [] } }, { pill: false });
    try {
      await S.sleep(PAST_WAIT_MS);
      const t0 = Date.now();
      await sendNow(n, "claude", TEXT);
      assert.deepEqual(await waitSent("claude", t0), [TEXT], "ルールが無ければ、確認なしでそのまま届く");
      assert.equal(await S.sidebarState(n), null, "サイドバーは出ない");
    } finally { await n.close(); }

    // 答えが来たあとは今どおり: 分からないあいだのタブに、遅れて「Pro でない」(お試しが終わっていた) が届くと、
    // ルールは効かず (off)、確認は出ない。ExtPay は問い合わせを始めるときにインストールの日時を読むので、いったん止めを
    // 外し、お試しが終わった日時にしてから、もう一度止める
    await release();
    await h.ext.evaluate((t) => chrome.storage.sync.set({ extensionpay_installed_at: new Date(t).toISOString() }), Date.now() - 8 * DAY);
    const releaseLate = await holdProAnswer();
    try {
      const late = await openSite("claude", {}, { pill: false });
      try {
        await S.sleep(PAST_WAIT_MS);
        await waitSettings(late, { hasSecretLists: true }); // 分からないあいだは、伏せる側に倒している
        await releaseLate(); // 止めていた問い合わせが、無料版の答えで返る
        await waitSettings(late, { pro: false, hasSecretLists: false });
        const t0 = Date.now();
        await sendNow(late, "claude", TEXT);
        assert.deepEqual(await waitSent("claude", t0), [TEXT], "答えが来たあと (Pro でない): 確認なしで、そのまま届く");
        assert.equal(await S.sidebarState(late), null, "サイドバーは出ない");
      } finally { await late.close(); }
    } finally { await releaseLate(); }
  } finally {
    await release();
    await setInstalledAt(Date.now()); // お試しに戻す
  }
});
