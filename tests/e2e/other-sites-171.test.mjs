// tests/e2e/other-sites-171.test.mjs — Claude / Gemini / Manus (モックのサイト) と対象外のサイト
// (docs/release-1.7.1.md の「Claude と Gemini で、伏せなかった値が本文に残ると送れない」T-OS-01〜14)。
// 2026-11-08 のシステムテスト (QA-171) の QA-OS をリポジトリに入れたもの。
// テストベース: STORE_DESCRIPTION.txt (「確認用のサイドバー」「添付ファイル」「ほかのやり取りへの備え」「それ以外のサイトでは起動しません」)、
// docs/security/other-providers-status.md (LK-01〜09)、docs/composer-toggle.md
//
// デシジョンテーブル (マスキング × 確認 × 個人情報):
//   D1 オン・オン・有 → 確認が開く。確定で伏せ字が届く        (T-OS-02)
//   D2 オン・オン・無 → 確認なしで、そのまま届く               (T-OS-05)
//   D3 オン・オフ・有 → 確認なしで、伏せ字が届く               (T-OS-06)
//   D4 オフ・*・有   → 確認なしで、原文が届く。アイコンが黄色 (T-OS-07)
//
// QA-171 で見つけて、まだ直していない不具合は確かめない: 画面幅と明暗のレイアウト (DEF-QA-07、08)、
// サイドバーを閉じたあとの body の style (DEF-QA-06)、キャンセルのあとの会話のスクロール位置 (DEF-QA-04)、
// Manus でキャンセルしたあとの下書き (DEF-QA-05)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launchSites, pillState, waitPill, waitSidebar, sidebarState, clickInShadow, modalState, rectsOverlap, inViewport, rectOf, FAKE, RAW, EG, sleep, SHOTS } from "../fixtures/sites-harness.mjs";

const SIDEBAR = 'div[data-pii-guard="sidebar"]';
const PII_TEXT = `連絡先は ${FAKE.phone} と ${FAKE.email} です`;
const CLEAN_TEXT = "来週の会議の議題をまとめてください";
const td = new TextDecoder();

const SITES = {
  claude: {
    url: "https://claude.ai/new", editor: ".ProseMirror", buttons: ["#cl-plus", "#cl-model", "#cl-send"], file: "#cl-file",
    sent: (srv, since) => srv.byKind("claude-rpc", since).map((r) => { const v = EG.getAtPath(new Uint8Array(r.bytes), [2, 3]); return v ? td.decode(v) : null; }),
  },
  gemini: {
    url: "https://gemini.google.com/app", editor: "rich-textarea .ql-editor", buttons: ["#gm-plus", "#gm-mode", "#gm-mic", "#gm-send"], file: "#gm-file",
    sent: (srv, since) => srv.byKind("gemini-session", since).map((r) => { const wc = EG.parseWebChannelForm(r.body); const v = wc && EG.getAtPath(wc.items[0].bytes, [2, 9, 1]); return v ? td.decode(v) : null; }),
  },
  manus: {
    url: "https://manus.im/app", editor: "#mn-input", buttons: ["#mn-plus", "#mn-mic", "#mn-send"], file: "#mn-file",
    sent: (srv, since) => srv.wsFrames.filter((f) => f.t >= since && f.data.startsWith("42")).map((f) => { try { const a = JSON.parse(f.data.slice(2)); return a[1] && a[1].type === "user_message" ? a[1].content : null; } catch (_) { return null; } }).filter((x) => x !== null),
  },
};

let H;
before(async () => { H = await launchSites(); });
after(async () => { if (H) await H.close(); });

const BASE = { enabled: true, interactive: true, uiMode: "sidebar", maskAllowlist: [], maskForceList: [] };
async function openSite(site, storage = {}) {
  await H.setStorage({ ...BASE, ...storage });
  const p = await H.open(SITES[site].url);
  await waitPill(p);
  return p;
}
async function typeDraft(p, site, text) {
  await p.click(SITES[site].editor);
  await p.keyboard.type(text, { delay: 2 });
  await sleep(900); // 下書きの見張り (400ms) と検出
}
const draftOf = (p, site) => p.evaluate((sel) => { const el = document.querySelector(sel); return el ? (el.tagName === "TEXTAREA" ? el.value : el.innerText.replace(/\n+$/, "")) : null; }, SITES[site].editor);
const events = (p) => p.evaluate(() => QA.events.map((e) => e.type));
const extErrors = (p) => p.__errors.filter((e) => /chrome-extension:\/\//.test(e));
async function waitEvent(p, type, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if ((await events(p)).includes(type)) return true; await sleep(100); } return false; }
async function shot(p, name) { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `os-${name}.png`) }).catch(() => {}); }

for (const site of Object.keys(SITES)) {
  test(`T-OS-01 ${site}: 読み込み: アイコンが入力欄のそばに出て、サイトのボタンに重ならない。保護入力欄は出ない。拡張機能のエラーが無い`, async () => {
    const p = await openSite(site);
    try {
      const st = await pillState(p);
      assert.ok(st && st.layout && st.layout.toggle, "アイコンが出る");
      assert.equal(st.enabled, "true");
      const t = st.layout.toggle;
      assert.ok(inViewport(t, 1280, 800), `アイコンが画面の中 (${t})`);
      assert.ok(t[2] >= 24 && t[2] <= 44 && t[3] >= 24 && t[3] <= 44, `アイコンの大きさ (${t[2]}x${t[3]})`);
      for (const b of SITES[site].buttons) {
        const r = await rectOf(p, b);
        assert.ok(!rectsOverlap(t, r), `アイコンが ${b} (${r}) に重ならない (アイコン ${t})`);
      }
      const ed = await rectOf(p, SITES[site].editor);
      assert.ok(Math.abs((t[1] + t[3] / 2) - (ed[1] + ed[3] / 2)) < 120, `アイコンが入力欄の近く (アイコン ${t} / 入力欄 ${ed})`);
      assert.equal(await p.evaluate(() => !!document.querySelector("[data-pii-guard-secure]")), false, "保護入力欄 (ChatGPT だけ) は出ない");
      // V-02: 除外リストなどの値はページ (MAIN world) に配らない
      const exposed = await p.evaluate(() => { const s = window.__localMaskMCP && window.__localMaskMCP.settings; return s ? Object.keys(s).filter((k) => /allow|force|llmUrl|llmModel/i.test(k) && s[k] && (Array.isArray(s[k]) ? s[k].length : true)) : []; });
      assert.deepEqual(exposed, [], "リストの値はページから読めない");
      assert.deepEqual(extErrors(p), [], "拡張機能のスクリプトのエラーが無い");
      await shot(p, `${site}-01-load`);
    } finally { await p.close(); }
  });

  test(`T-OS-02 ${site}: (D1) 個人情報を送ると確認のサイドバーが開き、確定で伏せ字だけが届く。閉じるとページの作りが元に戻る`, async () => {
    const p = await openSite(site);
    try {
      const t0 = Date.now();
      await typeDraft(p, site, PII_TEXT);
      await p.keyboard.press("Enter");
      const sb = await waitSidebar(p);
      assert.ok(sb, "サイドバーが開く");
      assert.equal(sb.title, "マスク対象の確認");
      assert.ok(sb.rows.length >= 2, `見つかった項目が並ぶ (${sb.rows.map((r) => r.label).join(" / ")})`);
      assert.ok(sb.rows.some((r) => r.sev === "critical") && sb.rows.some((r) => r.sev === "high"), "重要度が付く");
      assert.ok(sb.preview && !sb.preview.includes(FAKE.phone) && !sb.preview.includes(FAKE.email) && /<PHONE_NUMBER_\d+>/.test(sb.preview), `プレビューが伏せ字 (${sb.preview})`);
      assert.equal(SITES[site].sent(H.server, t0).length, 0, "確定する前は届かない");
      await shot(p, `${site}-02-sidebar`);
      assert.ok(await clickInShadow(p, SIDEBAR, /マスクして送信/), "確定ボタンを押せる");
      assert.ok(await waitEvent(p, "sent"), "ページの送信が終わる");
      await sleep(500);
      const sent = SITES[site].sent(H.server, t0);
      assert.equal(sent.length, 1, `1 回だけ届く (${sent.length})`);
      assert.ok(!sent[0].includes(FAKE.phone) && !sent[0].includes(FAKE.email) && /<PHONE_NUMBER_\d+>/.test(sent[0]) && /<EMAIL_ADDRESS_\d+>/.test(sent[0]), `伏せ字が届く (${sent[0]})`);
      assert.equal(H.leaksOf(RAW, t0).total, 0, "原文はどの通信にも載らない");
      assert.equal(await sidebarState(p), null, "サイドバーが閉じる");
      // body の style は確かめない (閉じたあとに margin が残る。DEF-QA-06 はまだ直していない)
      const after = await p.evaluate(() => ({ wrapper: !!document.querySelector("[data-mask-mcp-wrapper]"), layoutStyle: !!document.querySelector("style[data-mask-mcp-layout]") }));
      assert.equal(after.wrapper, false, "包みの要素が残らない");
      assert.equal(after.layoutStyle, false, "ページに足した style が残らない");
      assert.deepEqual(extErrors(p), []);
    } finally { await p.close(); }
  });

  test(`T-OS-03 ${site}: 確認でキャンセルすると届かず、下書きが残る。Esc でも閉じる (下書きと Esc は Claude と Gemini だけ)`, async () => {
    const p = await openSite(site);
    try {
      const t0 = Date.now();
      await typeDraft(p, site, PII_TEXT);
      await p.keyboard.press("Enter");
      assert.ok(await waitSidebar(p), "サイドバーが開く");
      assert.ok(await clickInShadow(p, SIDEBAR, /キャンセル/), "キャンセルを押せる");
      // Manus は送信が WebSocket なので、サイドバーを開いた時点でページは送ったと扱い、下書きを消す。
      // キャンセルのあとは「届かない」と「原文が載らない」だけを確かめる (DEF-QA-05 はまだ直していない)
      const manus = site === "manus";
      if (!manus) assert.ok(await waitEvent(p, "send-failed"), "ページには送信の失敗に見える");
      await sleep(400);
      assert.equal(SITES[site].sent(H.server, t0).length, 0, "届かない");
      assert.equal(H.leaksOf(RAW, t0).total, 0, "原文はどの通信にも載らない");
      if (manus) return;
      assert.equal(await draftOf(p, site), PII_TEXT, "下書きが残る");
      // Esc でも閉じる (キーボード操作)
      await p.click(SITES[site].editor);
      await p.keyboard.press("End");
      await p.keyboard.press("Enter");
      assert.ok(await waitSidebar(p), "もう一度開く");
      await p.keyboard.press("Escape");
      await sleep(400);
      assert.equal(await sidebarState(p), null, "Esc で閉じる");
      assert.equal(SITES[site].sent(H.server, t0).length, 0, "Esc でも届かない");
    } finally { await p.close(); }
  });

  test(`T-OS-04 ${site}: 項目ごとの切り替え: 電話番号を外すと、電話番号だけ原文で届き、メールは伏せ字`, async () => {
    const p = await openSite(site);
    try {
      const t0 = Date.now();
      await typeDraft(p, site, PII_TEXT);
      await p.keyboard.press("Enter");
      assert.ok(await waitSidebar(p), "サイドバーが開く");
      // 行は分類ごとに畳まれていることがあるので「すべて展開」を押してから行を押す
      await clickInShadow(p, SIDEBAR, /すべて展開/);
      const toggled = await p.evaluate((phone) => {
        const sr = document.querySelector('div[data-pii-guard="sidebar"]').shadowRoot;
        const row = [...sr.querySelectorAll(".row")].find((w) => (w.getAttribute("aria-label") || "").startsWith(phone));
        if (!row) return null;
        row.scrollIntoView({ block: "center" });
        const b = row.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
      }, FAKE.phone);
      assert.ok(toggled && toggled.w > 0 && toggled.h > 0, `電話番号の行が見えている (${JSON.stringify(toggled)})`);
      await p.mouse.click(toggled.x, toggled.y);
      await sleep(300);
      const sb = await sidebarState(p);
      const row = sb.rows.find((r) => r.label.startsWith(FAKE.phone));
      assert.equal(row.checked, "false", "電話番号の行がオフになる");
      assert.ok(sb.preview.includes(FAKE.phone) && !sb.preview.includes(FAKE.email), `プレビューに反映される (${sb.preview})`);
      await clickInShadow(p, SIDEBAR, /マスクして送信/);
      assert.ok(await waitEvent(p, "sent"), `送れる (${(await events(p)).slice(-2).join(",")})`);
      await sleep(400);
      const sent = SITES[site].sent(H.server, t0);
      assert.equal(sent.length, 1, "1 回届く");
      assert.ok(sent[0] !== null, "届いた本文が protobuf として読める (長さの情報が壊れていない)");
      assert.ok(sent[0].includes(FAKE.phone) && !sent[0].includes(FAKE.email), `電話番号だけ原文 (${sent[0]})`);
    } finally { await p.close(); }
  });

  test(`T-OS-05 ${site}: (D2) 個人情報が無ければ、確認を出さずにそのまま届く`, async () => {
    const p = await openSite(site);
    try {
      const t0 = Date.now();
      await typeDraft(p, site, CLEAN_TEXT);
      await p.keyboard.press("Enter");
      assert.ok(await waitEvent(p, "sent"), "送れる");
      assert.equal(await sidebarState(p), null, "サイドバーは出ない");
      await sleep(300);
      assert.deepEqual(SITES[site].sent(H.server, t0), [CLEAN_TEXT], "そのまま届く");
    } finally { await p.close(); }
  });

  test(`T-OS-06 ${site}: (D3) 確認をオフにすると、確認を出さずに伏せ字で届く`, async () => {
    const p = await openSite(site, { interactive: false });
    try {
      const t0 = Date.now();
      await typeDraft(p, site, PII_TEXT);
      await p.keyboard.press("Enter");
      assert.ok(await waitEvent(p, "sent"), "送れる");
      assert.equal(await sidebarState(p), null, "サイドバーは出ない");
      await sleep(300);
      const sent = SITES[site].sent(H.server, t0);
      assert.equal(sent.length, 1);
      assert.ok(!sent[0].includes(FAKE.phone) && !sent[0].includes(FAKE.email), `伏せ字で届く (${sent[0]})`);
      assert.equal(H.leaksOf(RAW, t0).total, 0);
    } finally { await p.close(); }
  });

  test(`T-OS-07 ${site}: (D4) マスキングがオフなら、個人情報があるとアイコンが黄色になり、確認なしで原文が届く`, async () => {
    const p = await openSite(site, { enabled: false });
    try {
      const st0 = await pillState(p);
      assert.equal(st0.enabled, "false", "アイコンがオフ表示");
      const t0 = Date.now();
      await typeDraft(p, site, PII_TEXT);
      const st = await pillState(p);
      assert.ok(st.warn && Number(st.warn) >= 2 && st.tone === "warning", `黄色になり件数が出る (${JSON.stringify({ warn: st.warn, tone: st.tone })})`);
      await shot(p, `${site}-07-off-warning`);
      await p.keyboard.press("Enter");
      assert.ok(await waitEvent(p, "sent"), "送れる");
      assert.equal(await sidebarState(p), null, "サイドバーは出ない");
      await sleep(300);
      assert.deepEqual(SITES[site].sent(H.server, t0), [PII_TEXT], "原文が届く (オフの約束どおり)");
    } finally { await p.close(); }
  });

  test(`T-OS-08 ${site}: 送る前: 打っている間・フォーカスを外したあと・入力欄をクリックしたあとに、原文を含む通信が出ない`, async () => {
    const p = await openSite(site);
    try {
      const t0 = Date.now();
      await typeDraft(p, site, `${PII_TEXT} 住所 ${FAKE.address}`);
      await sleep(1500);
      await p.evaluate(() => document.activeElement && document.activeElement.blur());
      await sleep(800);
      await p.click(SITES[site].editor); // Manus は自動計測が要素の文字を送る (LK-03)
      await sleep(1500);
      const lk = H.leaksOf(RAW, t0);
      assert.equal(lk.total, 0, `原文を含む通信が出ない (${JSON.stringify(lk)})`);
      if (site === "manus") {
        const amp = H.server.byKind("amplitude", t0);
        const fragments = amp.filter((r) => r.body.includes("連絡先は") || r.body.includes(FAKE.address.slice(0, 8)));
        assert.equal(fragments.length, 0, `解析ツールに下書きの断片が届かない (届いた ${amp.length} 件のうち断片入り ${fragments.length})`);
      }
      await p.keyboard.press("Control+A"); await p.keyboard.press("Delete");
    } finally { await p.close(); }
  });

  test(`T-OS-09 ${site}: テキストの添付: 中身とファイル名の個人情報を伏せてからページに渡る`, async () => {
    const p = await openSite(site);
    try {
      const t0 = Date.now();
      const content = `顧客メモ\n電話 ${FAKE.phone}\nメール ${FAKE.email}\n`;
      await p.setInputFiles(SITES[site].file, { name: `メモ_${FAKE.email}.txt`, mimeType: "text/plain", buffer: Buffer.from(content, "utf8") });
      assert.ok(await waitEvent(p, "attached"), "ページに添付が渡る");
      const att = await p.evaluate(() => QA.events.filter((e) => e.type === "attached").pop());
      const names = att.names.join(" "); const texts = att.texts.join(" ");
      assert.ok(!names.includes(FAKE.email), `ファイル名の個人情報が伏せられる (${names})`);
      assert.ok(!texts.includes(FAKE.phone) && !texts.includes(FAKE.email), `中身が伏せられる (${texts.replace(/\n/g, " / ")})`);
      if (site !== "claude") await waitEvent(p, "uploaded");
      await sleep(500);
      assert.equal(H.leaksOf(RAW, t0).total, 0, "原文はどの通信にも載らない");
      const st = await pillState(p);
      assert.notEqual(st.tone, "warning", "伏せられた添付では黄色にならない");
    } finally { await p.close(); }
  });

  test(`T-OS-10 ${site}: 画像の添付: マスキングがオンなら確認が出て、キャンセルで止まり、OK でそのまま添付してアイコンが黄色になる`, async () => {
    const p = await openSite(site);
    try {
      const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
      const dialogs = [];
      // 1 回目: キャンセル
      p.once("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
      await p.setInputFiles(SITES[site].file, { name: "screenshot.png", mimeType: "image/png", buffer: png });
      await sleep(1200);
      assert.equal(dialogs.length, 1, "確認が出る");
      const gotFiles = await p.evaluate(() => QA.events.filter((e) => e.type === "attached").reduce((n, e) => n + e.names.length, 0));
      assert.equal(gotFiles, 0, "キャンセルするとページにファイルが渡らない");
      let st = await pillState(p);
      assert.equal(st.tone, "warning", `止めた添付をアイコンが知らせる (${st.tone})`);
      await shot(p, `${site}-10-blocked`);
      // 2 回目: OK
      p.once("dialog", (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });
      await p.setInputFiles(SITES[site].file, { name: "screenshot2.png", mimeType: "image/png", buffer: png });
      let n2 = 0;
      for (let i = 0; i < 30 && n2 === 0; i++) { n2 = await p.evaluate(() => QA.events.filter((e) => e.type === "attached").reduce((n, e) => n + e.names.length, 0)); if (!n2) await sleep(100); }
      assert.equal(n2, 1, "OK ならページに渡る");
      st = await pillState(p);
      assert.equal(st.tone, "warning", "伏せずに添付したことをアイコンが知らせる");
      assert.ok(/画像|マスク|そのまま/.test(dialogs[0]), `確認の文 (${dialogs[0]})`);
    } finally { await p.close(); }
  });
}

test("T-OS-11 Claude の以前の送信の形 (JSON の completion) でも、確認のあと伏せ字で届く", async () => {
  await H.setStorage({ ...BASE });
  const p = await H.open("https://claude.ai/new?send=json");
  try {
    await waitPill(p);
    const t0 = Date.now();
    await typeDraft(p, "claude", PII_TEXT);
    await p.keyboard.press("Enter");
    assert.ok(await waitSidebar(p), "サイドバーが開く");
    await clickInShadow(p, SIDEBAR, /マスクして送信/);
    assert.ok(await waitEvent(p, "sent"));
    await sleep(300);
    const got = H.server.byKind("claude-json", t0).map((r) => JSON.parse(r.body).prompt);
    assert.equal(got.length, 1);
    assert.ok(!got[0].includes(FAKE.phone) && /<PHONE_NUMBER_\d+>/.test(got[0]), `伏せ字で届く (${got[0]})`);
  } finally { await p.close(); }
});

test("T-OS-12 確認の方式を「モーダル」にしても、確認のあと伏せ字で届く (同値分割: サイドバー/モーダル)", async () => {
  await H.setStorage({ ...BASE, uiMode: "modal" });
  const p = await H.open("https://claude.ai/new");
  try {
    await waitPill(p);
    const t0 = Date.now();
    await typeDraft(p, "claude", PII_TEXT);
    await p.keyboard.press("Enter");
    let m = null;
    for (let i = 0; i < 60 && !m; i++) { m = await modalState(p); if (!m) await sleep(100); }
    assert.ok(m, "モーダルが開く");
    assert.equal(await sidebarState(p), null, "サイドバーは出ない");
    await shot(p, "claude-12-modal");
    const clicked = await p.evaluate(() => {
      const h = [...document.querySelectorAll("body *")].find((e) => e.shadowRoot && e.getAttribute("data-pii-guard") !== "sidebar" && e.shadowRoot.querySelector("button"));
      const b = [...h.shadowRoot.querySelectorAll("button")].find((x) => /マスクして送信/.test(x.textContent));
      if (b) b.click();
      return b ? b.textContent.trim() : null;
    });
    assert.ok(clicked, `確定を押せる (${JSON.stringify(m.buttons)})`);
    assert.ok(await waitEvent(p, "sent"));
    await sleep(300);
    const sent = SITES.claude.sent(H.server, t0);
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].includes(FAKE.phone) && !sent[0].includes(FAKE.email), `伏せ字で届く (${sent[0]})`);
  } finally { await p.close(); }
});

for (const site of ["claude", "gemini"]) {
  test(`T-OS-13 ${site}: 除外リストの値は確認に出さずそのまま、常に伏せる語は伏せる (設定の反映)`, async () => {
    await H.setStorage({ ...BASE, maskAllowlist: [FAKE.email], maskForceList: [{ value: "カササギ計画", category: "OTHER" }] });
    const p = await H.open(SITES[site].url);
    try {
      await waitPill(p);
      const t0 = Date.now();
      await typeDraft(p, site, `${PII_TEXT} 件名はカササギ計画`);
      await p.keyboard.press("Enter");
      const sb = await waitSidebar(p);
      assert.ok(sb, "サイドバーが開く");
      const er = sb.rows.find((r) => r.label.startsWith(FAKE.email));
      assert.ok(!er || er.checked === "false", `除外した値は伏せない側になっている (${sb.rows.map((r) => r.label + ":" + r.checked).join(" / ")})`);
      assert.ok(sb.preview.includes(FAKE.email) && !sb.preview.includes("カササギ計画"), `プレビューに除外と常に伏せる語が反映される (${sb.preview})`);
      await clickInShadow(p, SIDEBAR, /マスクして送信/);
      assert.ok(await waitEvent(p, "sent"), `送れる (${(await events(p)).slice(-2).join(",")})`);
      await sleep(300);
      const sent = SITES[site].sent(H.server, t0);
      assert.equal(sent.length, 1, "1 回届く");
      assert.ok(sent[0].includes(FAKE.email) && !sent[0].includes(FAKE.phone) && !sent[0].includes("カササギ計画"), `除外は残り、常に伏せる語は伏せる (${sent[0]})`);
    } finally { await p.close(); }
  });
}

test("T-OS-14 対象外のサイトでは起動しない (アイコン・フック・通信の書き換えが無い)", async () => {
  await H.setStorage({ ...BASE });
  const p = await H.open("https://example.org/");
  try {
    await p.fill("#ta", PII_TEXT);
    await sleep(1200);
    const st = await p.evaluate(() => ({
      pill: !!document.querySelector('[data-pii-guard]'),
      ns: typeof window.__localMaskMCP,
      fetchNative: /\[native code\]/.test(Function.prototype.toString.call(window.fetch)),
      wsNative: /\[native code\]/.test(Function.prototype.toString.call(WebSocket.prototype.send)),
    }));
    assert.deepEqual(st, { pill: false, ns: "undefined", fetchNative: true, wsNative: true });
    const t0 = Date.now();
    await p.click("#post");
    await sleep(800);
    const got = H.server.byKind("oos-post", t0);
    assert.equal(got.length, 1);
    assert.equal(got[0].body, PII_TEXT, "対象外のサイトの通信は書き換えない");
  } finally { await p.close(); }
});
