// diag-log.js — 動作ログ。設計は docs/diagnostic-log.md。
//
// 拡張機能はブラウザのコンソールに何も書かない (R-LG-01)。代わりに、決まった種類の出来事だけを
// chrome.storage.local に 14 日分残し、設定画面の「ログ」タブで見せる。
//
// - 出来事の一覧 (CODES) にあるものだけを残す。項目の型は int / bool / enum / host / ver / layers
//   だけで、文章を入れられる型は無い。入力した文章や見つけた値は、仕組みとして入らない (D-LG-02)
// - 保存は Service Worker だけが行う (D-LG-03)。content script と拡張機能のページは log() で送り、
//   Service Worker は setSink() で受け口を差し替えて、自分で書く
// - このファイルは content script、拡張機能のページ、Service Worker (import "./diag-log.js")、
//   Node のテスト (require) のどれからでも読める
"use strict";

(function (root) {
  const RETENTION_DAYS = 14;
  const MAX_PER_DAY = 500;
  const MERGE_MS = 60 * 1000;
  const MAX_LAYERS = 6;
  const DAY_PREFIX = "diagLog:";
  const DAYS_KEY = "diagLogDays";
  const DAY_MS = 24 * 60 * 60 * 1000;

  // ---- 出来事の一覧 (D-LG-01) ------------------------------------------------
  const E = (labels) => ({ type: "enum", labels });
  const VIA = E({ fetch: "fetch", xhr: "XHR", ws: "WebSocket", beacon: "sendBeacon", "secure-composer": "Secure Composer" });
  const ATTACH_HOW = E({ picker: "ファイルの選択", drop: "ドラッグ", paste: "貼り付け" });
  const WHERE = E({
    masking: "伏せ字の処理", "draft-scan": "入力中の検出", llm: "LLM", "fetch-hook": "fetch の監視", "xhr-hook": "XHR の監視",
    "ws-hook": "WebSocket の監視", "beacon-hook": "sendBeacon の監視", storage: "設定の保存", review: "送信前の確認",
    persist: "リストへの保存", attachments: "添付", "secure-composer": "Secure Composer", "engine-load": "エンジンの読み込み",
    sidebar: "サイドバー", content: "ページとの橋渡し", options: "設定画面", popup: "メニュー", background: "バックグラウンド",
    offscreen: "ML の判定", page: "ページ側のスクリプト",
  });
  const ERROR_NAMES = ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError",
    "AggregateError", "DOMException", "AbortError", "NotAllowedError", "NotFoundError", "NotSupportedError",
    "InvalidStateError", "QuotaExceededError", "NetworkError", "TimeoutError", "SecurityError", "DataCloneError", "Other"];
  const REASON_IGNORED = { occluded: "ほかの表示と重なっていた", moved: "アイコンが動いた直後", "too-soon": "表示した直後" };

  const CODES = {
    "ext.updated": { lv: "info", fields: { from: "ver", to: "ver" },
      text: (d) => `拡張機能を更新しました${paren([d.from && d.to ? `${d.from} → ${d.to}` : ""])}` },
    "settings.enabled": { lv: "info", fields: { value: E({ on: "オン", off: "オフ" }), via: E({ icon: "入力欄のアイコン", popup: "拡張機能のメニュー", options: "設定画面" }) },
      text: (d, L) => `マスキングを${L.value || "切り替え"}${L.value ? "に" : ""}しました${paren([L.via])}` },
    "settings.changed": { lv: "info", fields: { what: E({ allowlist: "除外リスト", forcelist: "常に伏せる語", tint: "背景色", mode: "動作モード", llm: "LLM の設定", engine: "エンジンの設定", "secure-composer": "Secure Composer" }) },
      text: (d, L) => `設定を変えました${paren([L.what])}` },
    "send.masked": { lv: "info", fields: { via: VIA, attachments: "int" },
      text: (d, L) => `送信を伏せ字にしました${paren([L.via, d.attachments ? `添付 ${d.attachments} 件` : ""])}` },
    "send.cancelled": { lv: "info", fields: { via: VIA },
      text: (d, L) => `送信を取り消しました${paren([L.via])}` },
    "send.blocked": { lv: "warn", fields: { reason: E({ unmaskable: "伏せ字にできなかった", "lists-unavailable": "除外リストなどを読めなかった", "unknown-format": "知らない送信の形式", "hook-error": "処理の失敗", "engine-unavailable": "検出エンジンが使えない" }), via: VIA },
      text: (d, L) => `送信を止めました${paren([L.reason, L.via])}` },
    "egress.blocked": { lv: "warn", fields: { dest: "host", via: VIA },
      text: (d, L) => `送信以外の通信を止めました${paren([d.dest ? `宛先 ${d.dest}` : "", L.via])}` },
    "egress.scrubbed": { lv: "info", fields: { dest: "host", via: VIA },
      text: (d, L) => `送信以外の通信の個人情報を伏せ字にしました${paren([d.dest ? `宛先 ${d.dest}` : "", L.via])}` },
    "attach.masked": { lv: "info", fields: { count: "int", how: ATTACH_HOW },
      text: (d, L) => `添付を伏せ字にしました${paren([d.count != null ? `${d.count} 件` : "", L.how])}` },
    "attach.blocked": { lv: "warn", fields: { count: "int", reason: E({ binary: "書き換えられない形式", undecodable: "読めない文字コード", "no-target": "渡し先が無い", dialog: "ダイアログへのドロップ" }), how: ATTACH_HOW },
      text: (d, L) => `添付を止めました${paren([d.count != null ? `${d.count} 件` : "", L.reason, L.how])}` },
    "attach.unmasked": { lv: "info", fields: { count: "int" },
      text: (d) => `マスキングがオフなので、添付を伏せ字にせずに渡しました${paren([d.count != null ? `${d.count} 件` : ""])}` },
    "toggle.click_ignored": { lv: "warn", fields: { reason: E({ occluded: REASON_IGNORED.occluded, moved: REASON_IGNORED.moved }), layers: "layers" },
      text: (d, L) => `入力欄のアイコンへのクリックを受け付けませんでした${paren([L.reason])}${layersText(d.layers)}` },
    "confirm.click_ignored": { lv: "warn", fields: { reason: E({ occluded: REASON_IGNORED.occluded, "too-soon": REASON_IGNORED["too-soon"] }), layers: "layers" },
      text: (d, L) => `保存の確認へのクリックを受け付けませんでした${paren([L.reason])}${layersText(d.layers)}` },
    "ui.tampered": { lv: "warn", fields: { ui: E({ icon: "入力欄のアイコン", confirm: "保存の確認" }), what: E({ attributes: "属性の書き換え", "top-layer": "トップレイヤーから外された" }) },
      text: (d, L) => `ページが PII Guard の表示を書き換えたので、元に戻しました${paren([L.ui, L.what])}` },
    "llm.detect": { lv: (d) => (d.status === "failed" || d.status === "invalid-response" || d.status === "no-response" ? "warn" : "info"),
      fields: { status: E({ found: "結果あり", empty: "結果なし", "all-filtered": "すべて誤検出として除外", failed: "失敗", "invalid-response": "応答の形式が違う", "no-response": "応答なし" }), added: "int", filtered: "int" },
      text: (d, L) => `LLM の判定: ${L.status || "終了"}${paren([d.added != null ? `追加 ${d.added} 件` : "", d.filtered ? `除外 ${d.filtered} 件` : ""])}` },
    "llm.replace": { lv: (d) => (d.status === "ok" ? "info" : "warn"), fields: { status: E({ ok: "書き換えた", fallback: "使えず、通常の検出に戻した", failed: "失敗" }) },
      text: (d, L) => `LLM の書き換え: ${L.status || "終了"}` },
    "llm.http": { lv: "warn", fields: { status: "int" },
      text: (d) => (d.status === 403
        ? "ローカル LLM が接続を拒否しました (HTTP 403)。Ollama の OLLAMA_ORIGINS に chrome-extension://* を入れてください"
        : `ローカル LLM がエラーを返しました${paren([d.status ? `HTTP ${d.status}` : "応答なし"])}`) },
    "gateway.status": { lv: "warn", fields: { status: "int" },
      text: (d) => (d.status ? `ローカルのゲートウェイがエラーを返しました (HTTP ${d.status})` : "ローカルのゲートウェイに接続できません") },
    "engine.unavailable": { lv: "warn", fields: { where: WHERE },
      text: (d, L) => `検出エンジンが使えないため、処理できませんでした${paren([L.where])}` },
    "error": { lv: "error", fields: { where: WHERE, name: "errname" },
      text: (d, L) => `拡張機能の処理で問題が起きました${paren([L.where, d.name])}` },
    "log.capped": { lv: "warn", fields: {},
      text: () => `今日のログが上限 (${MAX_PER_DAY} 件) に達したので、これ以降は記録しません` },
  };
  const LEVEL_JA = { info: "情報", warn: "注意", error: "エラー" };
  const ROLES = new Set(["dialog", "alertdialog", "menu", "menubar", "listbox", "tooltip", "region", "presentation", "none",
    "status", "alert", "application", "complementary", "navigation", "group", "toolbar", "banner", "main", "button", "img"]);
  const SOURCES = new Set(["content", "page", "extension", "background"]);

  function paren(parts) {
    const p = parts.filter((x) => typeof x === "string" && x);
    return p.length ? ` (${p.join("、")})` : "";
  }
  function layersText(layers) {
    if (!Array.isArray(layers) || !layers.length) return "";
    const one = (l) => l.tag + (l.popover ? `[popover=${l.popover}]` : "") + (l.role && l.role !== "other" ? `[role=${l.role}]` : "") +
      (l.modal ? " (モーダル)" : "") + (l.overlap ? " (重なっていた)" : "");
    return `。トップレイヤーにあった要素: ${layers.map(one).join("、")}`;
  }

  // ---- 値の検め (D-LG-02) ----------------------------------------------------
  const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  function checkHost(v) {
    if (typeof v !== "string") return undefined;
    const h = v.toLowerCase();
    if (!HOST_RE.test(h)) return undefined;
    return h.includes(".") || h === "localhost" ? h : undefined;
  }
  function checkLayer(l) {
    if (!l || typeof l !== "object" || typeof l.tag !== "string") return null;
    const tag = l.tag.toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(tag)) return null;
    const popover = l.popover === "auto" || l.popover === "manual" || l.popover === "hint" ? l.popover : "";
    const role = typeof l.role === "string" && l.role ? (ROLES.has(l.role) ? l.role : "other") : "";
    return { tag, popover, role, modal: l.modal === true, overlap: l.overlap === true };
  }
  function checkValue(type, v) {
    if (type === "int") return Number.isInteger(v) && v >= 0 && v <= 1000000 ? v : undefined;
    if (type === "bool") return typeof v === "boolean" ? v : undefined;
    if (type === "host") return checkHost(v);
    if (type === "ver") return typeof v === "string" && /^\d{1,4}(\.\d{1,4}){1,3}$/.test(v) ? v : undefined;
    if (type === "errname") return typeof v === "string" ? (ERROR_NAMES.includes(v) ? v : "Other") : undefined;
    if (type === "layers") {
      if (!Array.isArray(v)) return undefined;
      return v.slice(0, MAX_LAYERS).map(checkLayer).filter(Boolean);
    }
    if (type && type.type === "enum") return typeof v === "string" && Object.prototype.hasOwnProperty.call(type.labels, v) ? v : undefined;
    return undefined;
  }
  // raw: { code, d, t }。meta: { src, site, now }。src と site は送り手ではなく受け手が決める
  function sanitize(raw, meta) {
    if (!raw || typeof raw !== "object" || typeof raw.code !== "string") return null;
    if (!Object.prototype.hasOwnProperty.call(CODES, raw.code)) return null;
    const spec = CODES[raw.code];
    const m = meta || {};
    const now = typeof m.now === "number" ? m.now : Date.now();
    const d = {};
    const src = raw.d && typeof raw.d === "object" ? raw.d : {};
    for (const [k, type] of Object.entries(spec.fields)) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      const v = checkValue(type, src[k]);
      if (v !== undefined) d[k] = v;
    }
    const t = typeof raw.t === "number" && Number.isFinite(raw.t) && raw.t <= now + 60000 && raw.t >= now - DAY_MS ? raw.t : now;
    return {
      t, code: raw.code, d,
      lv: typeof spec.lv === "function" ? spec.lv(d) : spec.lv,
      src: SOURCES.has(m.src) ? m.src : "extension",
      site: m.site == null ? null : (checkHost(m.site) || null),
      n: 1,
    };
  }
  // 例外から、名前と場所だけを取る (メッセージには入力が混ざることがあるので残さない)
  function errorFields(err, where) {
    const name = err && typeof err.name === "string" ? err.name : "Error";
    return { where, name };
  }

  // ---- 保存 (D-LG-04〜D-LG-06) ------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  function dateStr(t) { const x = new Date(t); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; }
  const dayKey = (t) => DAY_PREFIX + dateStr(t);
  // 残す日のうち最も古い日 (今日を含めて RETENTION_DAYS 日)
  function oldestKeptDay(now) {
    const x = new Date(now);
    x.setHours(12, 0, 0, 0);
    x.setDate(x.getDate() - (RETENTION_DAYS - 1));
    return dateStr(x.getTime());
  }
  const sameDetail = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function purge(storage, now) {
    const t = typeof now === "number" ? now : Date.now();
    const { [DAYS_KEY]: days = [] } = await storage.get(DAYS_KEY);
    const keep = oldestKeptDay(t);
    const old = (Array.isArray(days) ? days : []).filter((d) => d < keep);
    if (!old.length) return;
    await storage.remove(old.map((d) => DAY_PREFIX + d));
    await storage.set({ [DAYS_KEY]: days.filter((d) => d >= keep) });
  }

  // entries は sanitize() 済みのもの
  async function append(storage, entries, now) {
    const t0 = typeof now === "number" ? now : Date.now();
    const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
    if (!list.length) return;
    const keys = [...new Set(list.map((e) => dateStr(e.t)))];
    const got = await storage.get([DAYS_KEY, ...keys.map((k) => DAY_PREFIX + k)]);
    const days = new Set(Array.isArray(got[DAYS_KEY]) ? got[DAYS_KEY] : []);
    const buckets = {};
    for (const k of keys) buckets[k] = Array.isArray(got[DAY_PREFIX + k]) ? got[DAY_PREFIX + k] : [];
    for (const e of list) {
      const day = dateStr(e.t);
      const b = buckets[day];
      const last = b[b.length - 1];
      if (last && last.code === "log.capped") continue;
      if (last && last.code === e.code && last.site === e.site && last.src === e.src && sameDetail(last.d, e.d) &&
          e.t >= last.t && e.t - last.t <= MERGE_MS) {
        last.n = (last.n || 1) + (e.n || 1);
        last.t = e.t;
        continue;
      }
      if (b.length >= MAX_PER_DAY) {
        b.push({ t: e.t, code: "log.capped", d: {}, lv: "warn", src: "background", site: null, n: 1 });
        continue;
      }
      b.push({ ...e });
      days.add(day);
    }
    const out = { [DAYS_KEY]: [...days].sort() };
    for (const k of keys) out[DAY_PREFIX + k] = buckets[k];
    try {
      await storage.set(out);
    } catch (_) {
      // 置き場所の上限: 古い日から消して、もう一度だけ書く
      const sorted = [...days].sort();
      if (sorted.length > 1) {
        await storage.remove(DAY_PREFIX + sorted[0]);
        out[DAYS_KEY] = sorted.slice(1);
        await storage.set(out);
      }
    }
    await purge(storage, t0);
  }

  async function readAll(storage, opts) {
    const o = opts || {};
    const now = typeof o.now === "number" ? o.now : Date.now();
    const span = Math.max(1, Math.min(RETENTION_DAYS, o.days || RETENTION_DAYS));
    const x = new Date(now);
    x.setHours(12, 0, 0, 0);
    x.setDate(x.getDate() - (span - 1));
    const from = dateStr(x.getTime());
    const { [DAYS_KEY]: days = [] } = await storage.get(DAYS_KEY);
    const wanted = (Array.isArray(days) ? days : []).filter((d) => d >= from);
    if (!wanted.length) return [];
    const got = await storage.get(wanted.map((d) => DAY_PREFIX + d));
    const all = [];
    for (const d of wanted) for (const e of got[DAY_PREFIX + d] || []) all.push(e);
    return all.sort((a, b) => b.t - a.t);
  }

  async function clear(storage) {
    const { [DAYS_KEY]: days = [] } = await storage.get(DAYS_KEY);
    await storage.remove([DAYS_KEY, ...(Array.isArray(days) ? days : []).map((d) => DAY_PREFIX + d)]);
  }

  // ---- 表示 (D-LG-07) --------------------------------------------------------
  function labelsFor(spec, d) {
    const L = {};
    for (const [k, type] of Object.entries(spec.fields)) {
      if (type && type.type === "enum" && d[k] != null) L[k] = type.labels[d[k]];
    }
    return L;
  }
  function format(e) {
    const spec = e && CODES[e.code];
    if (!spec) return "記録の形式が分かりません";
    return spec.text(e.d || {}, labelsFor(spec, e.d || {}));
  }
  function timeStr(t) {
    const x = new Date(t);
    return `${dateStr(t)} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
  }
  // コピー用の 1 行
  function formatLine(e) {
    return [timeStr(e.t), LEVEL_JA[e.lv] || e.lv, e.site || "拡張機能", format(e) + (e.n > 1 ? ` ×${e.n}` : "") +
      (e.src === "page" ? " (ページ側から報告)" : "")].join("  ");
  }

  // ---- 送り手 (D-LG-03, D-LG-10) ---------------------------------------------
  // 既定の受け口: Service Worker に送る。Service Worker は setSink() で自分の書き込みに差し替える
  let sink = null;
  let queue = [];
  let timer = null;
  function defaultSink(batch) {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
      const p = chrome.runtime.sendMessage({ type: "DIAG_LOG", entries: batch });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) { /* 拡張機能の更新直後など。ログは捨てる */ }
  }
  function flush() {
    timer = null;
    const batch = queue.splice(0, 50);
    if (queue.length) timer = setTimeout(flush, 200);
    if (!batch.length) return;
    try { (sink || defaultSink)(batch); } catch (_) { /* ログで処理を止めない */ }
  }
  // 出来事を 1 件残す。送信の処理を待たせないよう、まとめて後で送る。決して例外を投げない
  function log(code, d, extra) {
    try {
      if (!Object.prototype.hasOwnProperty.call(CODES, code)) return;
      queue.push({ code, d: d || {}, t: Date.now(), ...(extra && extra.src === "page" ? { src: "page" } : {}) });
      if (queue.length > 200) queue.splice(0, queue.length - 200);
      if (!timer) timer = setTimeout(flush, 200);
    } catch (_) { /* 何もしない */ }
  }
  function setSink(fn) { sink = typeof fn === "function" ? fn : null; }
  // 待たずに今すぐ送る。すぐ閉じる画面 (拡張機能のメニュー) で、送る前に閉じて記録が消えないように
  function flushNow() {
    clearTimeout(timer);
    while (queue.length) flush();
  }

  // 拡張機能のページ・offscreen・content script の自分のエラーを拾い、コンソールに出さずに残す (D-LG-09)。
  // ownOnly: ファイル名が自分の拡張機能のものだけを拾う (content script はページのエラーを拾わない)
  function captureErrors(where, opts) {
    try {
      const o = opts || {};
      const base = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL("") : "";
      const ours = (text) => !o.ownOnly || (base && typeof text === "string" && text.includes(base));
      const target = typeof self !== "undefined" ? self : root;
      target.addEventListener("error", (ev) => {
        if (!ours(ev && ev.filename)) return;
        log("error", errorFields(ev && ev.error, where));
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      });
      target.addEventListener("unhandledrejection", (ev) => {
        const r = ev && ev.reason;
        if (!ours(r && r.stack)) return;
        log("error", errorFields(r, where));
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      });
    } catch (_) { /* 何もしない */ }
  }

  const api = {
    CODES, RETENTION_DAYS, MAX_PER_DAY, DAY_PREFIX, DAYS_KEY,
    sanitize, errorFields, dayKey, purge, append, readAll, clear, format, formatLine, timeStr,
    log, flushNow, setSink, captureErrors, checkHost,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PiiGuardDiagLog = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
