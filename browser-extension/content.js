// Content script — isolated-world bridge.
//
// MV3 content scripts run in an isolated JS world by default, which
// means monkey-patching ``window.fetch`` here only patches the
// extension's own wrapper, not the page's real fetch. We therefore:
//
// 1. Inject ``injected.js`` into the page's MAIN world via a script
//    tag. That script patches the real ``window.fetch`` and
//    ``XMLHttpRequest.prototype.send``.
// 2. Provide a ``window.postMessage`` bridge so the injected script
//    (which has no ``chrome.*`` access) can:
//      a) ask the isolated world to POST to the gateway on its behalf,
//         and
//      b) read the ``enabled`` flag from ``chrome.storage.local``.
//    The isolated world then relays detection counts back to the
//    service worker.
//
// All injected-script → content-script messages are tagged with
// ``source: "mask-mcp-inpage"`` so the page's own ``message`` handlers
// don't see them (and vice-versa for ``mask-mcp-content``).

(() => {
  "use strict";

  const TAG_IN = "mask-mcp-inpage";   // injected → content
  const TAG_OUT = "mask-mcp-content"; // content → injected

  // 動作ログ (docs/diagnostic-log.md)。コンソールには何も書かない (R-LG-01)
  const DL = window.PiiGuardDiagLog;
  const dlog = (code, d) => { if (DL) DL.log(code, d); };
  if (DL) DL.captureErrors("content", { ownOnly: true });
  // ページの世界 (injected.js など) からの記録。ページのスクリプトも送れるので、
  // Service Worker で検め直し「ページ側から報告」として残す。1 分に 60 件まで (D-LG-03)
  let pageLogWindow = 0;
  let pageLogCount = 0;
  function forwardPageLog(entry) {
    if (!DL || !entry || typeof entry !== "object" || typeof entry.code !== "string") return;
    const now = Date.now();
    if (now - pageLogWindow > 60000) { pageLogWindow = now; pageLogCount = 0; }
    if (++pageLogCount > 60) return;
    DL.log(entry.code, entry.d && typeof entry.d === "object" ? entry.d : {}, { src: "page" });
  }

  const GATEWAY_URL = "http://127.0.0.1:8081/v1/extension/sanitize";
  const GATEWAY_AGGREGATED_URL =
    "http://127.0.0.1:8081/v1/extension/sanitize/aggregated";
  const GATEWAY_HEALTH_URL = "http://127.0.0.1:8081/health";
  // Bumped from 3000 -> 15000 because the FIRST call from Chrome on
  // Windows to a WSL2-hosted gateway routinely takes several seconds:
  // Chrome's CORS-RFC1918 preflight on public-to-private fetches gets
  // re-negotiated on every fresh tab, and Windows's ephemeral port
  // mapping into the WSL2 VM has cold-start overhead that does NOT
  // show up when curling from inside WSL. Once warm the call is
  // milliseconds, but the first click in a fresh tab needs head-room.
  const GATEWAY_TIMEOUT_MS = 15000;

  // Cached gateway reachability. Hybrid dispatch in injected.js
  // consults this (via a postMessage round-trip) to decide whether to
  // call the gateway or fall back to the standalone engine. The
  // pre-warm below flips ``gatewayReachable`` true on a successful
  // /health response; injected.js can also ask for a refresh.
  let gatewayReachable = null; // null = unknown yet, true/false once probed
  const GATEWAY_PROBE_TIMEOUT_MS = 500;

  async function probeGateway() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        GATEWAY_PROBE_TIMEOUT_MS
      );
      try {
        const resp = await fetch(GATEWAY_HEALTH_URL, {
          method: "GET",
          mode: "cors",
          credentials: "omit",
          signal: controller.signal,
        });
        gatewayReachable = resp.ok;
        return resp.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch (_) {
      gatewayReachable = false;
      return false;
    }
  }

  // Pre-warm: hit /health in the background on content script load.
  // Also completes the PNA preflight + TCP warmup for the common
  // gateway-mode path. Sets gatewayReachable for Hybrid dispatch.
  (async () => {
    await probeGateway();
  })();

  // 1) Inject the page-world scripts in order:
  //    ``review-modal.js`` and ``sidebar.js`` must run before
  //    ``injected.js`` so the helper namespaces are already attached
  //    to ``window.__localMaskMCP.{reviewModal,sidebar}`` by the time
  //    the fetch hook tries to call them. ``document_start`` runs
  //    before any page script, so all three hooks are installed before
  //    the first fetch leaves the page. The ``async = false`` flag
  //    preserves source order despite the dynamic insertion.
  function injectScript(file) {
    const el = document.createElement("script");
    el.src = chrome.runtime.getURL(file);
    el.async = false;
    (document.head || document.documentElement).appendChild(el);
    el.addEventListener("load", () => el.remove());
  }
  // Engine modules are loaded BEFORE review-modal / sidebar / injected.js
  // so window.__localMaskMCP.engine is ready by the time injected.js's
  // first fetch intercept fires. Order matters: the leaf modules (no
  // cross-engine deps) must load before engine.js and the final
  // bundle.js launcher that flips engine.ready = true.
  // Each file is a MV3-safe script (no ES6 import / eval).
  //
  // v1.2.0: LLM engine files (surrogates.js, llm-prompts.js) now ship
  // to the Chrome Web Store build as well. Any LAN/localhost fetch they
  // eventually drive is gated by `optional_host_permissions: ["http://*/*"]`
  // in manifest.store.json — the user must approve that host at runtime
  // from the options page before the LLM proxy paths can succeed.
  const ENGINE_FILES = [
    // dictionaries.js must load BEFORE patterns.js — patterns.js references
    // dicts.JP_SURNAME_RE etc. at BUILTIN_PATTERNS construction time.
    "engine/dictionaries.js",
    "engine/patterns.js",
    "engine/classification.js",
    "engine/severity.js",
    "engine/categories.js",
    "engine/aggregate.js",
    "engine/force-mask.js",
    "engine/blocklist.js",
    "engine/user-force-mask.js",
    "engine/onnx-detector.js",
    "engine/confidential.js",
    "engine/surrogates.js",
    "engine/llm-prompts.js",
    "engine/pro-rules.js",
    "engine/engine.js",
    "engine/bundle.js",
  ];
  for (const f of ENGINE_FILES) injectScript(f);
  injectScript("review-modal.js");
  injectScript("sidebar.js");
  // 原文の持ち出しガード (F-EG-01〜04)。injected.js が使うので先に読む
  injectScript("security/egress-guard.js");
  injectScript("injected.js");

  // Push the current ``interactive`` + ``uiMode`` preferences into
  // MAIN world as soon as we can. The injected script reads them off
  // ``window.__localMaskMCP.settings`` before every fetch, so a
  // toggle in the popup takes effect on the very next intercept.
  // ``uiMode`` defaults to ``"sidebar"`` (Milestone 8 Wave B); the
  // legacy modal experience is opt-in via the popup radio.
  // F-SC-11 (fail-open 修正): Secure Composer の overlay が「実際に生きている」間だけ true。
  // adapter が iframe の ready で true、teardown/blocked/入力欄消失で false にする。これが
  // false の間は、SC 設定が ON でも injected.js は横取りを続ける (fail-closed)。既定 false =
  // overlay が確認できるまで素通ししない。機密の非配布 (V-02) はこれとは別に「設定」で常時効く。
  let scOverlayLive = false;
  // V-02: 除外リスト・常に伏せる語が変わったことだけを MAIN world に知らせる番号 (中身からは作らない)
  let listsVersion = 0;

  // ML がオンなら、ページを開いた時点でモデルを読み込んでおく (docs/release-1.7.1.md の D-SC-12)。送るときに
  // 読み込み (初回は取得に 1 分近く、キャッシュからでも温まるまでは 13〜22 秒) を待たずに済むようにする。ページごとに 1 回。読み込み済みなら
  // Service Worker は何もしない。content script は対応サイトすべてで動くので、保護入力欄以外の経路にも効く
  let mlPrewarmSent = false;
  function prewarmMl() {
    if (mlPrewarmSent) return;
    mlPrewarmSent = true;
    try { chrome.runtime.sendMessage({ type: "ML_PREWARM" }, () => void chrome.runtime.lastError); }
    catch (_) { /* 拡張機能が更新された直後など、Service Worker に届かないとき */ }
  }

  async function broadcastSettings() {
    let interactive = true;
    let uiMode = "sidebar";
    let maskAllowlist = [];
    let maskForceList = [];
    let enabled = true;
    let mlEnabled = false;
    // scOwnsComposer: このタブで Secure Composer が入力を受け持っているか (ChatGPT かつ
    // secureComposerEnabled)。MAIN world に配る非機密フラグ。injected.js はこれが true の間、
    // ChatGPT の送信を横取りしない (SC が唯一の経路。二重確認・再試行バイパスの根治, F-SC-11)。
    let scOwnsComposer = false;
    // [SECURITY] 除外リスト・常に伏せる語といった機密を MAIN world に配ると、ページ JS が読める
    // (V-02)。2026-10-18 から全サイトで配らない: ページ (injected.js / sidebar.js) のマスクと
    // 確認画面は、この ISOLATED world のエンジンに "local-mask" で頼み、渡された文についての
    // 結果だけを受け取る (handleLocalMask)。配るのは「リストがあるか」と変わった合図だけ。
    let hasSecretLists = false;
    // customRulesActive: Pro のカスタムルールが効いているか (真偽値だけ。ルールの中身は配らない)。ページの世界は、
    // これが true のあいだ LLM の置き換えモードを使わない (LLM はルールを知らないので、ルールの語を残して書き換えうる)
    let customRulesActive = false;
    const secureComposerHost = /(^|\.)(chatgpt\.com|openai\.com)$/.test(location.hostname);
    try {
      const stored = await chrome.storage.local.get([
        "interactive", "uiMode", "maskAllowlist", "maskForceList", "mlEnabled", "enabled", "secureComposerEnabled", CUSTOM_RULES_KEY,
      ]);
      if (typeof stored.mlEnabled === "boolean") mlEnabled = stored.mlEnabled;
      interactive = stored.interactive !== false;
      if (stored.uiMode === "modal" || stored.uiMode === "sidebar") {
        uiMode = stored.uiMode;
      }
      enabled = stored.enabled !== false;
      const scEnabled = secureComposerHost && stored.secureComposerEnabled !== false;
      // 2 つを分離する:
      //  - secretsStayLocal (V-02): 機密を MAIN world に出さないのは「設定」で決める。overlay の
      //    生死に連動させると、起動直後 (overlay が live になる前) の配布に機密が乗ってページに
      //    読まれてしまう。設定が ON なら常に出さない。
      //  - scOwnsComposer (F-SC-11 fail-open 修正): injected.js を素通しさせるのは overlay が実際に
      //    live なときだけ。overlay が無ければ injected.js がマスクに戻る (fail-closed)。
      scOwnsComposer = scEnabled && scOverlayLive;
      // リストの値は配らない (maskAllowlist / maskForceList は空のまま)。有無だけ知らせる:
      // ISOLATED に頼めないときに、MAIN world のエンジン (リスト無し) で黙って続けず止めるため。
      // Pro のカスタムルールも同じ。組み立てを待たずに、読んだ中身で決める (ページの世界が早く止める側に倒れるように)。
      // ルールがあって Pro かどうかがまだ分からないあいだも、効いているものとして扱う (分からないときは伏せる側に倒す)
      customRulesActive = hasEnabledCustomRule(stored[CUSTOM_RULES_KEY]) && (proEnabled || !proAnswered);
      hasSecretLists = (Array.isArray(stored.maskAllowlist) && stored.maskAllowlist.length > 0) ||
        (Array.isArray(stored.maskForceList) && stored.maskForceList.length > 0) ||
        customRulesActive;
    } catch (_) {
      interactive = true;
      uiMode = "sidebar";
    }
    if (mlEnabled) prewarmMl();
    window.postMessage(
      {
        source: TAG_OUT,
        type: "settings",
        settings: { interactive, uiMode, maskAllowlist, maskForceList, mlEnabled, enabled, scOwnsComposer, hasSecretLists, customRulesActive, listsVersion, pro: proEnabled },
      },
      "*"
    );
  }
  // Pro かどうか (docs/pro-license.md の D-PRO-06)。Service Worker のライセンス管理に聞き、この ISOLATED world の
  // エンジンに渡し、ページの世界 (injected.js) へは設定と一緒に配る。答えが来るまでは無料版のルールで動く
  let proEnabled = false;
  // proAnswered: Pro かどうかの答えを受け取ったか (届かない・失敗したあいだは false = 分からない)。
  // firstProAttempt: 最初の問い合わせが終わったこと (答えでも失敗でも)。保存したカスタムルールがあるときだけ、渡す前に待つ
  let proAnswered = false;
  let resolveProAttempt = () => {};
  const firstProAttempt = new Promise((resolve) => { resolveProAttempt = resolve; });
  function refreshPro() {
    try {
      chrome.runtime.sendMessage({ type: "license:get" }, (r) => {
        // 届かない・失敗した問い合わせと、ライセンスの確かめに失敗した答え (source: "none"。7 日以内のキャッシュが無いまま、
        // 通信に失敗したか時間切れ) は、「答えが来ていない」と同じに扱う (Pro でないと分かったわけではない)。Pro かどうかは
        // 前のまま、proAnswered も立てない。保存したルールがあれば、送信は partial と同じに確認へ回り、聞き直しを続ける
        // (ルールが無い人は、どちらに扱っても動きは同じ: Pro にならず、待ちも聞き直しも起きない)
        if (chrome.runtime.lastError || !r || r.source === "none") { resolveProAttempt(); return; }
        const first = !proAnswered;
        proAnswered = true;
        const next = !!(r && r.pro === true);
        const e = window.__localMaskMCP && window.__localMaskMCP.engine;
        if (e && typeof e.setProEnabled === "function") e.setProEnabled(next);
        // Pro の状態が変わったら (どちらの向きでも)、または最初の答えが来たら (分からなかったあいだの扱いを外す)、
        // カスタムルールを渡し直して配り直す
        if (next !== proEnabled || first) { proEnabled = next; syncCustomRules(); broadcastSettings(); }
        resolveProAttempt();
      });
    } catch (_) { resolveProAttempt(); /* 拡張機能が入れ替わった直後など、Service Worker に届かないとき */ }
  }

  // ---- Pro のカスタムルール (Pro Phase 2 の設計 (P1)) ----------------------------------------------
  // 保存したルール (chrome.storage.local の proCustomRules) を、この ISOLATED world のエンジンに渡す (Pro でなければ空)。
  // ページの世界 (injected.js・sidebar.js) には渡さず、ルールがあることだけを hasSecretLists で知らせる (V-02)。
  // 組み立てと温め (setCustomRules) は上限いっぱいで 0.9 秒ほどかかるので、送るたびではなく、起動・ルールの変化・
  // Pro の状態の変化のときに行う。読んだのにまだ渡していないあいだは伏せない: 読み直しと渡しを 1 本の列に並べ
  // (applyingCustomRules)、伏せる道 (handleLocalMask と添付の見張り) は、エンジンを動かす前に customRulesReady() で
  // 列が空くのを待つ。最後に渡したもの (Pro かどうかと、ルールの版) と同じなら組み立て直さない (Pro でページを開くと、
  // 起動の読み直しと「Pro に変わった」の読み直しが続くため。組み立ては、このページと同じスレッドで走る)
  const CUSTOM_RULES_KEY = "proCustomRules"; // engine/custom-rules.js の STORAGE_KEY と同じ
  const hasEnabledCustomRule = (v) => !!(v && Array.isArray(v.rules) && v.rules.some((r) => r && typeof r === "object" && r.enabled !== false));
  // E2E のときだけ (__pii_guard_e2e が true) 上書きできる時間の上限 (時間切れや、Pro の答えを待つあいだを確かめるため):
  // カスタムルールの時間の上限 (__pii_guard_e2e_custom_budget_ms) と、Pro かどうかの答えを待つ上限 (__pii_guard_e2e_pro_wait_ms)
  const E2E_FLAG = "__pii_guard_e2e";
  const E2E_BUDGET_KEY = "__pii_guard_e2e_custom_budget_ms";
  const E2E_PRO_WAIT_KEY = "__pii_guard_e2e_pro_wait_ms";
  const e2eNumber = (st, key) => (st && st[E2E_FLAG] === true && Number.isFinite(st[key]) ? st[key] : null);
  const PRO_ANSWER_WAIT_MS = 3000; // ルールがあるときに、Pro かどうかの答えを待つ上限
  // 当てているカスタムルールの名前 (compileRules と同じく、有効で正しいもの)。集めた形の結果で、この名前の行に custom の
  // 印 (真偽値だけ) を付ける。ページの世界は、LLM の検出を混ぜるときにその行を残す (ルールの中身は渡さない)
  let appliedCustomLabels = new Set();
  function customLabelsOf(rules, cr) {
    const out = new Set();
    if (!cr || typeof cr.validateRule !== "function") return out;
    for (const r of Array.isArray(rules) ? rules : []) {
      if (!r || typeof r !== "object" || r.enabled === false) continue;
      const checked = cr.validateRule(r);
      if (checked.ok) out.add(checked.rule.label);
    }
    return out;
  }
  let applyingCustomRules = Promise.resolve();
  let customRulesVersion = 0; // proCustomRules が変わるたびに増やす
  let appliedCustomRules = null; // 最後に渡したもの ("off" か "pro:<版>")
  // ルールがあるのに、待っても Pro かどうか分からない (答えが待つ上限までに来ない・問い合わせに失敗した)。
  // ルールを当てられないので、伏せる道は時間切れ (custom.status の partial) と同じに扱う
  let customRulesUnknown = false;
  function syncCustomRules() {
    const version = customRulesVersion;
    applyingCustomRules = applyingCustomRules.then(async () => {
      let got = {};
      try { got = await chrome.storage.local.get([CUSTOM_RULES_KEY, E2E_FLAG, E2E_PRO_WAIT_KEY]); } catch (_) { got = {}; }
      const stored = got[CUSTOM_RULES_KEY];
      const has = hasEnabledCustomRule(stored);
      // ルールがあるのに、Pro かどうかの答えがまだなら待つ (ルールの無い人は待たせない)
      const waitMs = e2eNumber(got, E2E_PRO_WAIT_KEY) ?? PRO_ANSWER_WAIT_MS;
      if (has) await Promise.race([firstProAttempt, new Promise((r) => setTimeout(r, waitMs))]);
      customRulesUnknown = has && !proAnswered;
      const engine = await waitIsoEngine(3000);
      if (!engine || typeof engine.setCustomRules !== "function") return;
      const on = proEnabled && has;
      const key = on ? `pro:${version}` : "off";
      if (key === appliedCustomRules) return;
      engine.setCustomRules(on ? stored.rules : []);
      appliedCustomRules = key;
      appliedCustomLabels = on ? customLabelsOf(stored.rules, engine.customRules) : new Set();
    }).catch((e) => { dlog("error", DL ? DL.errorFields(e, "content") : {}); });
  }
  // 列が空くまで待つ (待っているあいだに次の読み直しが並んだら、それも待つ)。Pro かどうか分からないままなら true を返す。
  // そのときは、答えが来るよう聞き直す (5 秒に 1 回まで。届かなかった問い合わせのあとも、いつかは今どおりに戻るように)
  let lastProRetry = 0;
  async function customRulesReady() {
    let last;
    do { last = applyingCustomRules; await last; } while (last !== applyingCustomRules);
    if (customRulesUnknown && Date.now() - lastProRetry > 5000) { lastProRetry = Date.now(); refreshPro(); }
    return customRulesUnknown;
  }

  // adapter (同じ isolated world) が overlay の生死を知らせる口。live が変わるたびに再配布し、
  // injected.js の scOwnsComposer と機密配布を即座に切り替える (fail-closed, F-SC-11)。
  window.__localMaskMCP = window.__localMaskMCP || {};
  window.__localMaskMCP.__scSetOverlayLive = (v) => {
    const next = !!v;
    if (next === scOverlayLive) return;
    scOverlayLive = next;
    broadcastSettings();
  };
  // 添付の見張り (attachments/attachment-guard.js、同じ ISOLATED world) が、伏せる前にカスタムルールを待つ口
  window.__localMaskMCP.__customRulesReady = customRulesReady;
  broadcastSettings();
  refreshPro();
  syncCustomRules();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if ("licenseState" in changes) refreshPro();
      if ("maskAllowlist" in changes || "maskForceList" in changes) listsVersion++;
      if (CUSTOM_RULES_KEY in changes) { customRulesVersion++; syncCustomRules(); }
      if ("interactive" in changes || "uiMode" in changes || "maskAllowlist" in changes || "maskForceList" in changes || "mlEnabled" in changes || "enabled" in changes || "secureComposerEnabled" in changes || CUSTOM_RULES_KEY in changes) {
        broadcastSettings();
      }
    });
  } catch (_) {
    // ``chrome.storage`` is always available in an MV3 content
    // script; the guard exists only to avoid bricking the page if
    // the API ever throws at boot.
  }

  // ---- V-02: ページのマスクを、リスト込みでこの ISOLATED world のエンジンで行う ----------------
  // kind: "sanitize" (maskSanitize) / "aggregated" (maskAggregated、除外リストの行に masked:false と
  // allowlisted:true の印) / "lists" (確認画面の再計算用: 渡された値のうち除外リストにあるもの、
  // 渡された文の中の「常に伏せる語」の位置)。返すのは渡された文についての結果だけ。
  // ページは任意の文を投げて、ある語がリストにあるかを試せる (問い合わせによる推測)。マスクの結果は
  // ページの通信に載るので避けられない限界。リストそのものを丸ごと読める状態よりは狭い。
  const isoEngine = () => {
    const e = window.__localMaskMCP && window.__localMaskMCP.engine;
    return e && e.ready && typeof e.maskSanitize === "function" ? e : null;
  };
  async function waitIsoEngine(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && !isoEngine()) await new Promise((r) => setTimeout(r, 50));
    return isoEngine();
  }
  const forceEntryOf = (e) => (typeof e === "string" ? { value: e, category: "OTHER" }
    : e && typeof e.value === "string" ? { value: e.value, category: typeof e.category === "string" ? e.category : "OTHER" } : null);
  // カスタムルールの時間の上限。ページの送信は、送る前の上限 (custom-rules.js の LIMITS.sendBudgetMs)。E2E の上書きあり
  function sendBudgetMs(engine, st) {
    const e2e = e2eNumber(st, E2E_BUDGET_KEY);
    if (e2e !== null) return e2e;
    const cr = engine.customRules;
    return cr && cr.LIMITS ? cr.LIMITS.sendBudgetMs : undefined;
  }
  async function handleLocalMask(data) {
    const { id, kind, text } = data;
    let result = null;
    try {
      if (typeof text === "string" && text.length <= 2 * 1024 * 1024) {
        const engine = await waitIsoEngine(3000);
        if (engine) {
          const st = await chrome.storage.local.get(["maskAllowlist", "maskForceList", "mlEnabled", E2E_FLAG, E2E_BUDGET_KEY]);
          const allow = new Set((Array.isArray(st.maskAllowlist) ? st.maskAllowlist : []).filter((v) => typeof v === "string"));
          const force = (Array.isArray(st.maskForceList) ? st.maskForceList : []).map(forceEntryOf).filter(Boolean);
          const opts = { userForceMaskEntries: force, mlEnabled: st.mlEnabled === true, customBudgetMs: sendBudgetMs(engine, st) };
          // 保存したカスタムルールを渡し終えてから伏せる (読んだのにまだ渡していない状態で、伏せない)
          const customUnknown = await customRulesReady();
          if (kind === "aggregated") {
            result = await engine.maskAggregated(text, opts);
            for (const row of (result && Array.isArray(result.aggregated) ? result.aggregated : [])) {
              if (row && allow.has(row.value)) { row.masked = false; row.allowlisted = true; }
              // Pro のカスタムルールの行の印 (真偽値だけ)。LLM の検出を混ぜるとき、ページの世界はこの行の位置と名前を残す
              if (row && appliedCustomLabels.has(row.label)) row.custom = true;
            }
          } else if (kind === "lists") {
            const values = (Array.isArray(data.values) ? data.values : []).filter((v) => typeof v === "string").slice(0, 500);
            const ufm = engine.userForceMask;
            result = {
              allowValues: values.filter((v) => allow.has(v)),
              forceDetections: ufm && typeof ufm.detectUserForceMask === "function" && force.length ? ufm.detectUserForceMask(text, force) : [],
            };
          } else {
            result = await engine.maskSanitize(text, opts);
          }
          // ルールがあるのに Pro かどうか分からず、ルールを当てられなかった: 時間切れと同じに扱う (ページの世界が確認に回す)
          if (customUnknown && kind !== "lists" && result) result.custom = { status: "partial" };
        }
      }
    } catch (_) { result = null; }
    window.postMessage({ source: TAG_OUT, id, type: "local-mask-result", result }, "*");
  }

  // F-EG-03: このサイトで前に覚えた持ち出しガードの記憶を、起動時に SW から取っておく
  const egressRestore = new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "EGRESS_RESTORE" }, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp && resp.ok ? resp : { values: [], drafts: [] });
      });
    } catch (_) { resolve({ values: [], drafts: [] }); }
    setTimeout(() => resolve({ values: [], drafts: [] }), 1500);
  });

  // 2) Handle page-world requests.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG_IN) return;

    if (data.type === "diag-log") { forwardPageLog(data.entry); return; }

    // Allowlist add (no id — fire-and-forget write to chrome.storage).
    // 除外リストと常に伏せる語の変更 (サイドバーから)。ページ側 (MAIN world) からの
    // メッセージはサイトのスクリプトにも送れるので、ここでは保存しない。isolated world の
    // 閉じた UI (composer-toggle.js) が利用者に確認を出し、押されたときだけ保存する (1.6.0)
    if ((data.type === "add-allowlist" || data.type === "add-forcelist" || data.type === "remove-forcelist") && typeof data.value === "string") {
      const confirm = window.__localMaskMCP && window.__localMaskMCP.composerToggle && window.__localMaskMCP.composerToggle.confirmPersist;
      if (typeof confirm === "function") {
        confirm({ type: data.type, value: data.value, category: typeof data.category === "string" ? data.category : null });
      } else {
        dlog("error", { where: "persist", name: "NotSupportedError" });
      }
      return;
    }

    // F-EG-03: 持ち出しガードの記憶の保存と復元 (SW の chrome.storage.session、サイトごと)。
    // ページからも送れるメッセージだが、SW は送り手のタブのサイトの記憶しか触らせない。
    if (data.type === "egress-remember") {
      try {
        chrome.runtime.sendMessage({
          type: "EGRESS_REMEMBER",
          values: Array.isArray(data.values) ? data.values.slice(0, 200) : [],
          drafts: Array.isArray(data.drafts) ? data.drafts.slice(0, 20) : [],
        });
      } catch (_) { /* SW が眠っていても致命的ではない */ }
      return;
    }
    if (data.type === "egress-restore-request") {
      egressRestore.then((r) => {
        window.postMessage({ source: TAG_OUT, type: "egress-restore", values: r.values || [], drafts: r.drafts || [] }, "*");
      });
      return;
    }

    // ページ側のスクリプトが受け取りの準備をしてから設定を取りに来る (1.5.1)。
    // 起動直後に送った設定は、受け取り手の読み込み前だと失われ、除外リストも
    // 常に伏せる語も効かなかった。id を持たない要求なので、下の id 判定より前で受ける
    if (data.type === "request-settings") {
      broadcastSettings();
      return;
    }

    if (typeof data.id !== "string") return;

    if (data.type === "local-mask") {
      handleLocalMask(data);
    } else if (data.type === "sanitize") {
      handleSanitize(data);
    } else if (data.type === "sanitize-aggregated") {
      handleSanitizeAggregated(data);
    } else if (data.type === "is-enabled") {
      handleIsEnabled(data);
    } else if (data.type === "backend-probe") {
      handleBackendProbe(data);
    } else if (data.type === "hybrid-pref") {
      handleHybridPref(data);
    }
    else if (data.type === "llm-config") {
      handleLlmConfig(data);
    } else if (data.type === "llm-call") {
      handleLlmCall(data);
    } else if (data.type === "detection-count") {
      // Fire-and-forget badge update.
      try {
        chrome.runtime.sendMessage({
          type: "DETECTION_COUNT",
          count: Number(data.count) || 0,
        });
      } catch (_) {
        // Service worker might be asleep; not fatal.
      }
    }
  });

  async function handleSanitize(data) {
    const { id, payload } = data;
    const responseBody = await callGateway(GATEWAY_URL, payload);
    window.postMessage(
      { source: TAG_OUT, id, type: "sanitize-result", result: responseBody },
      "*"
    );
  }

  async function handleSanitizeAggregated(data) {
    const { id, payload } = data;
    const responseBody = await callGateway(GATEWAY_AGGREGATED_URL, payload);
    window.postMessage(
      {
        source: TAG_OUT,
        id,
        type: "sanitize-aggregated-result",
        result: responseBody,
      },
      "*"
    );
  }

  // Shared transport for the two sanitize endpoints. Identical
  // request semantics; only the URL changes. Returns null on any
  // failure so the caller can fall back to ``confirmSendUnmasked``.
  async function callGateway(url, payload) {
    let responseBody = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
          mode: "cors",
          credentials: "omit",
        });
        if (resp.ok) {
          responseBody = await resp.json();
        } else {
          dlog("gateway.status", { status: resp.status });
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (_) {
      dlog("gateway.status", { status: 0 });
    }
    return responseBody;
  }

  // Hybrid mode: report current gateway reachability to the injected
  // script. Refresh on demand if ``data.refresh === true``, otherwise
  // return the cached value (populated by the warmup probe or the last
  // refresh call). Result is also used to display a badge update when
  // we fall back to standalone mode.
  async function handleBackendProbe(data) {
    const { id } = data;
    if (data.refresh === true || gatewayReachable === null) {
      await probeGateway();
    }
    const reachable = gatewayReachable === true;
    try {
      chrome.runtime.sendMessage({
        type: "BACKEND_MODE",
        mode: reachable ? "gateway" : "standalone",
      });
    } catch (_) {
      // service worker asleep — not fatal.
    }
    window.postMessage(
      {
        source: TAG_OUT,
        id,
        type: "backend-probe-result",
        reachable,
      },
      "*"
    );
  }

  // Returns the user's Hybrid-mode preference from chrome.storage.local.
  // Recognised values:
  //   "auto"       — probe gateway, fall back to standalone (default)
  //   "standalone" — never call gateway, always use local engine
  //   "gateway"    — always use gateway (legacy behaviour); fail loudly
  //                  if unreachable. Expert-mode only.
  async function handleHybridPref(data) {
    const { id } = data;
    // Web Store build: default to standalone (no Docker required).
    // Power users can opt into "gateway" / "auto" via DevTools but
    // the shipped UX assumes a self-contained browser-only engine.
    let pref = "standalone";
    try {
      const stored = await chrome.storage.local.get(["mask_mcp_pref_hybrid"]);
      const v = stored.mask_mcp_pref_hybrid;
      if (v === "standalone" || v === "gateway" || v === "auto") {
        pref = v;
      }
    } catch (_) {
      pref = "standalone";
    }
    window.postMessage(
      {
        source: TAG_OUT,
        id,
        type: "hybrid-pref-result",
        pref,
      },
      "*"
    );
  }

  // v0.5.0 — Local LLM proxy. The page world never directly calls
  // the user-configured LLM URL; it asks us via postMessage and we
  // execute the fetch from the isolated content script (which, after
  // the user grants `http://*/*` via permissions.request() from the
  // options page, holds the runtime host permission).
  //
  // v1.2.0: the handlers below ship to the Chrome Web Store build too.
  // They are no-ops until the user (a) sets localLlmEnabled + URL from
  // the options page, and (b) approves the `http://*/*` optional host
  // permission prompt. Without those, handleLlmConfig returns
  // `config: null` and handleLlmCall short-circuits.
  async function handleLlmConfig(data) {
    const { id } = data;
    // [SECURITY] MAIN world (= ページが読める) には機密を出さない。LLM の URL・モデル・
    // 種別は isolated world と SW だけが持つ。ページには「有効か」「モード」「タイムアウト」
    // という非機密の表示用の値だけ返す。実際の URL/モデルは handleLlmCall が chrome.storage
    // から組み立てる (V-03 の解消, threat-model INV-4)。
    let cfg = null;
    try {
      const stored = await chrome.storage.local.get([
        "localLlmEnabled", "localLlmUrl", "localLlmMode", "localLlmTimeoutMs",
      ]);
      if (
        stored.localLlmEnabled === true &&
        typeof stored.localLlmUrl === "string" &&
        stored.localLlmUrl
      ) {
        cfg = {
          mode: stored.localLlmMode === "replace" ? "replace" : "detect",
          timeoutMs: Number(stored.localLlmTimeoutMs) || 120000,
        };
      }
    } catch (_) {}
    window.postMessage(
      { source: TAG_OUT, id, type: "llm-config-result", config: cfg },
      "*"
    );
  }

  async function handleLlmCall(data) {
    const { id, system, user } = data;
    let result = null;
    // [SECURITY] ページが渡してきた config は信用しない。URL・パス・モデル・種別は
    // すべて chrome.storage の保存値から組み立てる。これで偽装した llm-call に任意の
    // パス (/api/pull など) やモデルを叩かせない (V-04 の解消, threat-model INV-3)。
    let config = null;
    try {
      const stored = await chrome.storage.local.get([
        "localLlmEnabled", "localLlmUrl", "localLlmModel", "localLlmKind", "localLlmTimeoutMs",
      ]);
      if (stored.localLlmEnabled === true && typeof stored.localLlmUrl === "string" && stored.localLlmUrl) {
        config = {
          url: stored.localLlmUrl.replace(/\/+$/, ""),
          model: stored.localLlmModel || "",
          kind: stored.localLlmKind === "openai-compat" ? "openai-compat" : "ollama",
          timeoutMs: Number(stored.localLlmTimeoutMs) || 120000,
        };
      }
    } catch (_) { config = null; }
    if (!config || !config.url) {
      window.postMessage({ source: TAG_OUT, id, type: "llm-call-result", result: null }, "*");
      return;
    }
    // Route the actual fetch through the service worker (background.js)
    // so Chrome's Private Network Access blocker doesn't reject an
    // HTTPS-page content script calling http://localhost.
    const isOpenAi = config.kind === "openai-compat";
    const url = config.url + (isOpenAi ? "/v1/chat/completions" : "/api/chat");
    // Ollama request needs THREE things for thinking-capable models
    // (Qwen3 family, Deepseek-R1, etc.) to emit visible tokens:
    //   1. think: false        — disables the built-in reasoning trace.
    //      Without this, the model burns the entire num_predict budget
    //      on internal <think>…</think> tokens that Ollama hides from
    //      the .message.content field, leaving content = "" at the end.
    //   2. format: "json"      — grammar-constrains the output to valid
    //      JSON so we don't need to strip markdown fences.
    //   3. num_predict: 2048   — enough for a 30-entity detect response
    //      without blowing the context window.
    const body = JSON.stringify(
      isOpenAi
        ? {
            model: config.model || "default",
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            stream: false,
            temperature: 0,
            response_format: { type: "json_object" },
            max_tokens: 2048,
          }
        : {
            model: config.model || "qwen3:1.7b",
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            stream: false,
            think: false,
            format: "json",
            options: {
              temperature: 0,
              num_predict: 2048,
            },
          }
    );
    // Retry loop for Ollama cold-start. A 9B/8B model can take 30–60s
    // to load into VRAM on first invocation and Ollama returns
    //   500 {"error":"unexpected server status: llm server loading model"}
    // (or a 503) during that window. The body comes back fast, so we
    // can retry cheaply without waiting for the full timeout. We only
    // retry on "loading model" responses — 403 CORS and hard errors
    // bail immediately.
    // Retry budget — split by cause. Cold-start 500/503 "loading
    // model" answers come back fast, so we can poll cheaply. Timeouts
    // (AbortError) are genuine inference stalls — we allow a small
    // number of re-runs so 9B thinking models that exceed one timeout
    // window still get a second chance after the KV cache is warm.
    const WARMUP_MAX = 6;      // 500/503 loading-model retries
    const WARMUP_DELAY_MS = 3000;
    const TIMEOUT_MAX = 2;     // AbortError retries (inference too slow)
    const TIMEOUT_DELAY_MS = 2000;
    let warmupTries = 0;
    let timeoutTries = 0;
    while (true) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "LLM_FETCH",
          url,
          method: "POST",
          body,
          timeoutMs: config.timeoutMs || 120000,
        });
        if (resp && resp.ok && resp.body) {
          const j = JSON.parse(resp.body);
          result = isOpenAi
            ? j?.choices?.[0]?.message?.content
            : j?.message?.content;
          result = result || null;
          break;
        }
        const warming =
          resp &&
          (resp.status === 500 || resp.status === 503) &&
          typeof resp.body === "string" &&
          /loading model|model is still loading|server loading/i.test(resp.body);
        if (warming && warmupTries < WARMUP_MAX) {
          warmupTries++;
          await new Promise((r) => setTimeout(r, WARMUP_DELAY_MS));
          continue;
        }
        // SW-side fetch abort surfaces as { ok:false, error:"signal is
        // aborted without reason" } (or similar). Treat this the same
        // as a JS-side AbortError — allow a couple of re-runs.
        const abortLike =
          resp && !resp.ok && typeof resp.error === "string" &&
          /abort|aborted|AbortError/i.test(resp.error);
        if (abortLike && timeoutTries < TIMEOUT_MAX) {
          timeoutTries++;
          await new Promise((r) => setTimeout(r, TIMEOUT_DELAY_MS));
          continue;
        }
        // 応答の中身は残さない (LLM の出力に入力が含まれる)。番号だけ
        dlog("llm.http", { status: resp && Number.isInteger(resp.status) ? resp.status : 0 });
        break;
      } catch (err) {
        const isAbort = err && err.name === "AbortError";
        if (isAbort && timeoutTries < TIMEOUT_MAX) {
          timeoutTries++;
          await new Promise((r) => setTimeout(r, TIMEOUT_DELAY_MS));
          continue;
        }
        dlog("error", DL ? DL.errorFields(err, "llm") : {});
        break;
      }
    }
    window.postMessage({ source: TAG_OUT, id, type: "llm-call-result", result }, "*");
  }

  async function handleIsEnabled(data) {
    const { id } = data;
    let enabled = true;
    try {
      const stored = await chrome.storage.local.get("enabled");
      enabled = stored.enabled !== false;
    } catch (_) {
      enabled = true;
    }
    window.postMessage(
      { source: TAG_OUT, id, type: "is-enabled-result", enabled },
      "*"
    );
  }
})();
