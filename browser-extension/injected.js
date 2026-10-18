// Page-world (MAIN world) script.
//
// Injected by content.js at ``document_start``. Patches the real
// ``window.fetch`` and ``XMLHttpRequest.prototype.send`` so outgoing
// user-input POSTs to supported AI services are routed through the
// local gateway before leaving the browser.
//
// This script has no access to ``chrome.*`` APIs. It talks to the
// isolated content script via ``window.postMessage``:
//
//   injected → content: { source: "mask-mcp-inpage", id, type, ... }
//   content → injected: { source: "mask-mcp-content", id, type, ... }
//
// The content script relays sanitize calls to the gateway, reads the
// enabled flag from ``chrome.storage.local``, and forwards detection
// counts to the service worker for badge updates.

(() => {
  "use strict";

  const LOG = (...args) => console.debug("[pii-guard]", ...args);
  const WARN = (...args) => console.warn("[pii-guard]", ...args);

  // Query params that commonly carry session credentials. Our diagnostic
  // LOGs echo URLs verbatim, which means JWT/API-key leaks into console
  // and any screenshot / paste. Redaction keeps the host + path visible
  // (useful for endpoint discovery) while masking secrets.
  const SENSITIVE_QS = [
    "token",
    "auth",
    "key",
    "api_key",
    "access_token",
    "sentry_key",
    "session",
  ];

  function redactUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      let dirty = false;
      for (const k of SENSITIVE_QS) {
        if (u.searchParams.has(k)) {
          u.searchParams.set(k, "REDACTED");
          dirty = true;
        }
      }
      return dirty ? u.toString() : raw;
    } catch (_) {
      return raw;
    }
  }

  // Dedupe diagnostic logs so ChatGPT-style telemetry floods don't
  // drown out the few LOG lines that matter (adapter hits, LLM
  // results). Key = "logTag|host+path" — we log once per unique
  // route per page load.
  const _logSeen = new Set();
  function logOnce(tag, url, extra) {
    try {
      const u = new URL(url, location.href);
      const key = tag + "|" + u.host + u.pathname;
      if (_logSeen.has(key)) return;
      _logSeen.add(key);
    } catch (_) {}
    if (extra !== undefined) LOG(tag, redactUrl(url), extra);
    else LOG(tag, redactUrl(url));
  }

  // Bounded-length snippet for logging WS frames. Socket.IO EVENT frames
  // start with ``42[...]`` and are usually under a few hundred chars —
  // 160 chars is enough to see the event name + first field without
  // drowning the console in long JSON payloads.
  function previewPayload(data, max = 160) {
    if (typeof data !== "string") return "(" + typeof data + ")";
    return data.length <= max
      ? data
      : data.slice(0, max) + "…(+" + (data.length - max) + " chars)";
  }

  const TAG_IN = "mask-mcp-inpage";   // outgoing to content script
  const TAG_OUT = "mask-mcp-content"; // incoming from content script

  let sequence = 0;
  const pending = new Map();

  // MAIN-world shared namespace used to hand data between
  // ``review-modal.js`` / ``sidebar.js`` and this script without
  // postMessage overhead. ``settings`` is refreshed whenever
  // content.js relays a new value (initial install + every
  // chrome.storage change). Defaults:
  //   * ``interactive: true``  — show review UI before sending.
  //   * ``uiMode: "sidebar"``  — Milestone 8 Wave B default. Old users
  //     who flip to "modal" in the popup get the legacy review-modal
  //     experience.
  const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
  NS.settings = NS.settings || { interactive: true, uiMode: "sidebar" };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG_OUT) return;
    // Settings broadcasts are a special "no id" message carrying the
    // latest ``interactive`` flag from chrome.storage.local.
    if (data.type === "settings" && data.settings) {
      NS.settings = {
        ...NS.settings,
        ...data.settings,
      };
      try {
        window.dispatchEvent(
          new CustomEvent("mask-mcp:settings-updated", {
            detail: NS.settings,
          })
        );
      } catch (_) {}
      return;
    }
    if (data.type === "egress-restore") {
      try { if (typeof NS.__egressRestore === "function") NS.__egressRestore(data); } catch (_) {}
      return;
    }
    if (typeof data.id !== "string") return;
    // composer-toggle.js (content script) からの下書きの確認の依頼
    if (data.type === "review-draft") { handleReviewDraft(data); return; }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    entry.resolve(data);
  });

  // 入力中の文章を対象にサイドバーを開き、承認結果を content script に返す (1.6.0)。
  // 入力欄への書き戻しは content script が行う
  async function handleReviewDraft(data) {
    const { id, text } = data;
    const reply = (payload) => window.postMessage({ source: TAG_IN, id, type: "review-draft-result", ...payload }, "*");
    try {
      if (typeof text !== "string" || !text.trim()) return reply({ accepted: false });
      const r = await NS.reviewDraft(text);
      if (!r || !r.aggResp) return reply({ accepted: false, error: "detect" });
      const sidebar = NS.sidebar;
      if (!sidebar || typeof sidebar.show !== "function") return reply({ accepted: false, error: "no-sidebar" });
      const decision = await sidebar.show(r.aggResp, text, {
        draft: true,
        mode: r.llmPending ? "detect" : "regex",
        llmPending: r.llmPending || undefined,
      });
      reply({ accepted: !!(decision && decision.accepted), maskedPositions: (decision && decision.maskedPositions) || [] });
    } catch (err) {
      reply({ accepted: false, error: String((err && err.message) || err) });
    }
  }
  // 受け取りの準備ができたので、設定 (除外リスト・常に伏せる語を含む) を
  // 取りに行く (1.5.1)。content.js は起動直後にも設定を送るが、このスクリプトの
  // 読み込みより先に届くと失われ、除外リストも常に伏せる語も効かなかった
  window.postMessage({ source: TAG_IN, type: "request-settings" }, "*");

  function request(type, extra, timeoutMs) {
    const id = `mcp-${++sequence}-${Date.now()}`;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      window.postMessage({ source: TAG_IN, id, type, ...extra }, "*");
      // Safety timeout — the content script should always reply;
      // this guards against a broken extension install. For most
      // request types 5s is plenty, but LLM calls against 9B+
      // thinking models can take 30–120s (model load + inference),
      // so callers override with their own budget + a small buffer.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(null);
        }
      }, typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 5000);
    });
  }

  // Hybrid mode state (Phase 1 of serverless engine).
  //
  // Decision rules, evaluated once per tab and cached:
  //
  //   1. pref === "standalone"  → always use local engine.
  //   2. pref === "gateway"     → always call gateway; no fallback.
  //   3. pref === "auto" (default) → probe gateway at warmup; if the
  //      probe says reachable, use gateway; otherwise use local engine.
  //
  // ``NS.settings.activeBackend`` is exposed for telemetry/debugging
  // (``window.__localMaskMCP.settings.activeBackend``).
  let hybridDecision = null; // "gateway" | "standalone"

  async function resolveBackend() {
    if (hybridDecision) return hybridDecision;
    const prefResp = await request("hybrid-pref", {});
    const pref =
      prefResp && prefResp.type === "hybrid-pref-result"
        ? prefResp.pref
        : "auto";
    if (pref === "standalone") {
      hybridDecision = "standalone";
    } else if (pref === "gateway") {
      hybridDecision = "gateway";
    } else {
      const probe = await request("backend-probe", {});
      const reachable =
        probe && probe.type === "backend-probe-result" && probe.reachable;
      hybridDecision = reachable ? "gateway" : "standalone";
    }
    NS.settings = { ...NS.settings, activeBackend: hybridDecision };
    return hybridDecision;
  }

  // Engine readiness resolves when bundle.js dispatches
  // "mask-mcp:engine-ready" or when polling detects engine.ready.
  // Safety timeout prevents callers from hanging if the engine scripts
  // silently fail to load (e.g., page CSP blocks chrome-extension://).
  const ENGINE_WAIT_MS = 3000;
  function isEngineReady(e) {
    return !!(e && e.ready && typeof e.maskAggregated === "function");
  }
  const enginePromise = new Promise((resolve) => {
    if (isEngineReady(NS.engine)) {
      resolve(NS.engine);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("mask-mcp:engine-ready", onReady);
      resolve(value);
    };
    // isolated world (composer-toggle.js 用のエンジン) も同じ名前のイベントを
    // 同じ window に飛ばすので、イベントだけで判断せず、自分の世界のエンジンが
    // 実際に使える状態かを確かめる (1.6.0)
    const onReady = () => { if (isEngineReady(NS.engine)) finish(NS.engine); };
    window.addEventListener("mask-mcp:engine-ready", onReady);
    const iv = setInterval(() => {
      if (isEngineReady(NS.engine)) {
        clearInterval(iv);
        finish(NS.engine);
      }
    }, 50);
    setTimeout(() => {
      clearInterval(iv);
      finish(isEngineReady(NS.engine) ? NS.engine : null);
    }, ENGINE_WAIT_MS);
  });

  async function getEngine() {
    const e = await enginePromise;
    return isEngineReady(e) ? e : null;
  }

  // V-02: マスクは ISOLATED world (content.js) のエンジンにリスト込みで頼む。リストの値は
  // MAIN world に来ない。kind: "sanitize" / "aggregated" / "lists" (確認画面の再計算)。
  async function localMask(kind, text, extra) {
    const resp = await request("local-mask", { kind, text, ...(extra || {}) }, 10000);
    return resp && resp.type === "local-mask-result" ? resp.result : null;
  }
  NS.requestLocal = (kind, payload) => localMask(kind, payload && payload.text, payload);
  // ISOLATED に頼めなかったとき: リストがあるなら、MAIN world のエンジン (リスト無し) で黙って
  // 続けると「常に伏せる語」を伏せないまま送る。マスク失敗として呼び手に返す (fail-closed)。
  const listsNeeded = () => !!(NS.settings && NS.settings.hasSecretLists);

  async function sanitizeOnce(text, service, sourceUrl) {
    const backend = await resolveBackend();
    if (backend === "standalone") {
      const local = await localMask("sanitize", text);
      if (local && typeof local.sanitized_text === "string") return local;
      if (listsNeeded()) { WARN("isolated masking unavailable; refusing to mask without the user's lists"); return null; }
      const engine = await getEngine();
      if (!engine) {
        // Engine missing AND gateway not preferred: degrade by returning
        // the raw text so the fetch hook's unmasked-confirm prompt fires.
        WARN(
          "standalone mode requested but engine unavailable after",
          ENGINE_WAIT_MS + "ms.",
          "Check DevTools Console for [pii-guard] engine bundle errors",
          "or CSP violations blocking chrome-extension:// scripts."
        );
        return null;
      }
      try {
        // maskSanitize is async (ML opt-in). The outer ``return await``
        // is required so a thrown error inside the promise lands in
        // the catch below rather than escaping the function.
        return await engine.maskSanitize(text, engineOpts());
      } catch (e) {
        WARN("standalone maskSanitize failed:", e?.message || e);
        return null;
      }
    }
    const resp = await request("sanitize", {
      payload: { text, service, source_url: sourceUrl },
    });
    if (!resp || resp.type !== "sanitize-result") return null;
    return resp.result; // may be null on gateway failure
  }

  // Engine オプション共通化 — ユーザー force-mask list と ML フラグを注入。
  // NS.settings は content.js が chrome.storage.local から配布。
  // MAIN world のエンジンは、ISOLATED に頼めなかったときの予備。リストは持たない (V-02)。
  function engineOpts() {
    const mlEnabled = !!(NS.settings && NS.settings.mlEnabled);
    return { userForceMaskEntries: [], mlEnabled };
  }

  async function sanitizeAggregated(text, service, sourceUrl) {
    // Sidebar mode goes through the aggregated endpoint. Hybrid flow:
    //   * standalone  → call the local engine synchronously.
    //   * gateway     → ask the content script to proxy to the gateway.
    const backend = await resolveBackend();
    if (backend === "standalone") {
      const local = await localMask("aggregated", text);
      if (local && Array.isArray(local.aggregated)) return local;
      if (listsNeeded()) { WARN("isolated masking unavailable; refusing to mask without the user's lists"); return null; }
      const engine = await getEngine();
      if (!engine) {
        WARN(
          "standalone mode requested but engine unavailable after",
          ENGINE_WAIT_MS + "ms.",
          "Check DevTools Console for [pii-guard] engine bundle errors",
          "or CSP violations blocking chrome-extension:// scripts."
        );
        return null;
      }
      try {
        return await engine.maskAggregated(text, engineOpts());
      } catch (e) {
        WARN("standalone maskAggregated failed:", e?.message || e);
        return null;
      }
    }
    const resp = await request("sanitize-aggregated", {
      payload: { text, service, source_url: sourceUrl },
    });
    if (!resp || resp.type !== "sanitize-aggregated-result") return null;
    return resp.result; // may be null on gateway failure
  }

  // v0.5.0 — Local LLM wrapper. Returns null when LLM is disabled /
  // unreachable / times out, so callers can treat "no augmentation"
  // as the normal case.
  async function llmAugment(text, mode) {
    try {
      const cfgResp = await request("llm-config", {});
      const cfg = cfgResp && cfgResp.config;
      if (!cfg) return null;
      const prompts = NS.engine && NS.engine.llmPrompts;
      if (!prompts) return null;
      const build =
        mode === "replace" ? prompts.buildReplacePrompt : prompts.buildDetectPrompt;
      const { system, user } = build(text);
      // Give the inner bridge enough time to cover the full SW
      // retry loop: up to 6 warming-up retries + 2 abort retries,
      // each with its own cfg.timeoutMs fetch window. Budget:
      //   (timeoutMs * 3) + 30s buffer
      // → for the 120s default this is ~6.5 min, which covers
      // even the slowest 4B cold-start scenarios while still
      // bounding how long a stuck request can hang.
      const innerBudget = (cfg.timeoutMs || 120000) * 3 + 30000;
      LOG(
        `llm ${mode}: inner bridge budget ${Math.round(innerBudget / 1000)}s (fetch timeout ${Math.round((cfg.timeoutMs || 120000) / 1000)}s)`,
      );
      const callResp = await request(
        "llm-call",
        { system, user, config: cfg },
        innerBudget,
      );
      const raw = callResp && callResp.result;
      if (!raw || typeof raw !== "string") {
        LOG(`llm ${mode}: no response (timeout / network / CORS)`);
        return null;
      }
      LOG(`llm ${mode}: got response (${raw.length} chars)`);
      // The LLM sometimes wraps JSON in ```json fences despite instructions.
      // Qwen3 / Deepseek-R1 / other "thinking" models wrap reasoning
      // in <think>...</think> before the actual answer. Strip those
      // blocks (including multi-line, including unclosed in case the
      // model truncated). Also strip ```json fences.
      let cleaned = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<think>[\s\S]*$/i, "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      // Some models leave a leading narrative before JSON. Find the
      // first `{` and last `}` and parse that substring.
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace > 0 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
      }
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (_) {
        LOG("llm response not JSON; ignoring");
        return null;
      }
      // [MEDIUM] Strict schema validation — a prompt-injected response
      // that returns free-form text or unexpected fields must be
      // rejected so the regex pipeline stays authoritative.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        LOG("llm response not object; ignoring");
        return null;
      }
      if (mode === "detect") {
        if (!Array.isArray(parsed.entities)) {
          LOG("llm detect response missing entities[]; ignoring");
          return null;
        }
        parsed.entities = parsed.entities.filter(
          (e) =>
            e &&
            typeof e === "object" &&
            typeof e.text === "string" &&
            e.text.trim().length > 0 &&
            e.text.length < 500 &&
            typeof e.entity_type === "string"
        );
        return parsed;
      }
      if (mode === "replace") {
        if (
          typeof parsed.rewritten_text !== "string" ||
          parsed.rewritten_text.length === 0
        ) {
          LOG("llm replace response missing rewritten_text; ignoring");
          return null;
        }
        return parsed;
      }
      return parsed;
    } catch (err) {
      WARN("llmAugment failed:", err?.message || err);
      return null;
    }
  }

  // Merge LLM-detected contextual entities with the regex aggregated
  // response. When LLM is connected (mode === "detect"), the LLM is
  // treated as the primary authority: any entity LLM flagged
  // REPLACES the regex/morphology entry for the same surface text
  // (label, category, severity all come from LLM). Entities regex
  // found but LLM did not are kept as a safety-net supplement so
  // structured PII (email, credit card, phone number) is never
  // silently dropped. Skips LLM entirely when config is missing.
  async function mergeLlmDetect(aggResp, text) {
    try {
      const cfgResp = await request("llm-config", {});
      const cfg = cfgResp && cfgResp.config;
      if (!cfg) {
        LOG("llm detect: SKIPPED (no config — enable toggle + set URL in options)");
        aggResp._llmStatus = "failed";
        return aggResp;
      }
      // In replace mode the primary path (full rewrite) runs earlier
      // in processBody. If it failed (timeout/network/partial), we
      // still want LLM contextual detection to augment the regex
      // pipeline — otherwise LLM effectively contributes nothing on
      // replace-mode failure. So detect runs for BOTH modes.
      if (cfg.mode !== "detect" && cfg.mode !== "replace") {
        LOG(`llm detect: SKIPPED (mode="${cfg.mode}", not detect/replace)`);
        aggResp._llmStatus = "failed";
        return aggResp;
      }
      LOG(`llm detect: querying local model (mode=${cfg.mode})`);
      // No showLoading() here — the sidebar's centered overlay is now
      // the sole LLM progress indicator when regex found ≥1 entity and
      // we opened the sidebar in parallel. For the zero-regex path
      // (sidebar can't be opened yet) we stay silent rather than
      // flashing a top-right pill before any UI is visible.
      const out = await llmAugment(text, "detect");
      let llmEnts = (out && Array.isArray(out.entities)) ? out.entities : [];
      // Distinguish three outcomes so the sidebar can render
      // appropriate feedback:
      //   "failed"       — LLM did not respond (timeout / CORS / network)
      //   "ok_empty"     — LLM answered, but with no entities
      //   "ok_entities"  — LLM answered with at least one entity
      if (!llmEnts.length) {
        aggResp._llmStatus = out === null ? "failed" : "ok_empty";
        LOG(
          `llm detect: ${aggResp._llmStatus} — keeping regex/morphology only`,
        );
        return aggResp;
      }
      aggResp._llmStatus = "ok_entities";
      // Post-filter: drop common false positives even if the LLM
      // labeled them. This is a safety net against an over-eager
      // model that flags job titles, generic IT terms, or polite
      // phrases.
      const LLM_DENYLIST = new Set([
        // Job titles / roles
        "エンジニア", "インフラエンジニア", "プログラマー", "デザイナー",
        "マネージャー", "リーダー", "部長", "課長", "社長", "CTO", "CEO",
        "PM", "PL", "アルバイト", "正社員", "フリーランス", "コンサルタント",
        // IT common nouns (words, not actual values)
        "パスワード", "アクセスキー", "APIキー", "API キー", "トークン",
        "認証情報", "秘密鍵", "公開鍵", "ハッシュ", "セッション",
        "Cookie", "JWT", "OAuth", "SSH", "SSL", "HTTPS", "HTTP",
        "JSON", "YAML", "CSS", "SQL", "Database", "API", "REST", "GraphQL",
        // Generic business terms
        "プロジェクト", "会議", "ミーティング", "タスク", "チケット",
        "レポート", "ドキュメント", "データ", "システム", "サーバー",
        "クライアント", "ユーザー", "メンバー", "チーム", "部署", "組織",
        "営業", "経理", "開発", "人事", "総務",
        // Public orgs / technical tools
        "政府", "省庁", "警察", "国税庁", "GitHub", "Docker", "Kubernetes",
        "AWS", "GCP", "Azure",
      ]);
      const LLM_DENY_REGEX = [
        /^エンジニア$/, /エンジニア$/,          // all "…エンジニア"
        /^(?:パス|アクセス)(?:ワード|キー)$/,  // パスワード, アクセスキー
        /^.+(?:部長|課長|係長|主任|取締役|社長)$/, // 何々部長 etc.
      ];
      const filtered = llmEnts.filter((e) => {
        const v = (e && e.text) || "";
        if (typeof v !== "string" || !v.trim()) return false;
        if (LLM_DENYLIST.has(v)) {
          LOG(`llm detect: dropped false positive "${v}" (denylist)`);
          return false;
        }
        if (LLM_DENY_REGEX.some((re) => re.test(v))) {
          LOG(`llm detect: dropped false positive "${v}" (pattern)`);
          return false;
        }
        // Short surfaces that are pure hiragana are almost always
        // particles / polite phrases mis-tagged.
        if (v.length <= 3 && /^[ぁ-ん]+$/.test(v)) {
          LOG(`llm detect: dropped short hiragana "${v}"`);
          return false;
        }
        return true;
      });
      if (filtered.length !== llmEnts.length) {
        LOG(
          `llm detect: filtered ${llmEnts.length - filtered.length} ` +
            `false positives, ${filtered.length} kept`
        );
      }
      llmEnts = filtered;
      if (!llmEnts.length) {
        LOG("llm detect: all LLM entities filtered out; keeping regex only");
        return aggResp;
      }
      const LABEL_TO_CATEGORY = {
        PERSON: "PERSON",
        COMPANY: "ORGANIZATION",
        LOCATION: "LOCATION",
        DEPARTMENT: "OTHER",
        PROJECT_CODE: "OTHER",
        CREDENTIAL: "CREDENTIAL",
        SENSITIVE_FACT: "OTHER",
      };
      const LABEL_TO_SEVERITY = {
        PERSON: "critical",
        COMPANY: "critical",
        LOCATION: "high",
        DEPARTMENT: "medium",
        PROJECT_CODE: "medium",
        CREDENTIAL: "critical",
        SENSITIVE_FACT: "high",
      };
      // Build the LLM rows first (they become authoritative). We scan
      // ALL occurrences of each value in the input so multi-occurrence
      // surfaces ("田中さんから田中部長に伝言") get every instance
      // masked rather than just the first.
      const llmRows = [];
      const llmValues = new Set();
      const counters = {};
      for (const ent of llmEnts) {
        const value = typeof ent.text === "string" ? ent.text.trim() : "";
        if (!value || llmValues.has(value)) continue;
        const label = String(ent.entity_type || "SENSITIVE_FACT").toUpperCase();
        // 英数字の語の途中は除く (「1234567」を「123456789012」の中で見つけない)。
        // 人名は、名字の後の下の名前と、フルネームの各部分も含める (1.5.1)
        const agg = NS.engine && NS.engine.aggregate;
        const positions = !agg ? [] : label === "PERSON" && typeof agg.personSpans === "function"
          ? agg.personSpans(text, value)
          : typeof agg.findOccurrences === "function" ? agg.findOccurrences(text, value) : [];
        if (!positions.length) continue;
        const category = LABEL_TO_CATEGORY[label] || "OTHER";
        const severity = LABEL_TO_SEVERITY[label] || "medium";
        counters[label] = (counters[label] || 0) + 1;
        llmRows.push({
          value,
          label,
          category,
          count: positions.length,
          positions,
          masked: true,
          placeholder: `<${label}_${counters[label]}>`,
          classification: "contextual",
          severity,
          source: "llm",
        });
        llmValues.add(value);
      }
      // Keep regex rows ONLY when LLM didn't already flag that surface.
      // This gives LLM final say on label/severity while retaining
      // structured regex detections (email, credit card, etc.) that
      // LLM might not have surfaced.
      const keptRegex = (aggResp.aggregated || []).filter(
        (a) => !llmValues.has(String(a.value))
      );
      const replaced = (aggResp.aggregated || []).length - keptRegex.length;
      // LLM rows come first in the aggregated list so the sidebar
      // shows them at the top of their severity tab.
      aggResp.aggregated = [...llmRows, ...keptRegex];
      LOG(
        `llm detect merge: +${llmRows.length} llm entities, ` +
          `+${keptRegex.length} regex kept, ${replaced} regex overridden by LLM`
      );
      return aggResp;
    } catch (err) {
      WARN("mergeLlmDetect failed:", err?.message || err);
      aggResp._llmStatus = "failed";
      return aggResp;
    }
  }

  // 下書きの確認 (composer-toggle.js から呼ばれる)。送信時と同じ検出を行い、
  // LLM が有効ならその統合も始める。サイドバーには llmPending を渡す
  NS.reviewDraft = async function reviewDraft(text) {
    const aggResp = await sanitizeAggregated(text, "draft", location.href);
    if (!aggResp) return null;
    let llmPending = null;
    try {
      const cfgResp = await request("llm-config", {});
      if (cfgResp && cfgResp.config) llmPending = mergeLlmDetect(aggResp, text);
    } catch (_) { llmPending = null; }
    return { aggResp, llmPending };
  };

  async function isEnabled() {
    const resp = await request("is-enabled", {});
    if (!resp || resp.type !== "is-enabled-result") return true;
    return resp.enabled !== false;
  }

  function reportDetectionCount(count) {
    if (!count || count <= 0) return;
    window.postMessage(
      {
        source: TAG_IN,
        id: `badge-${++sequence}-${Date.now()}`,
        type: "detection-count",
        count,
      },
      "*"
    );
  }

  // --- Service adapters (same registry pattern as the gateway side) ------

  const claudeAdapter = {
    name: "claude",
    // Matches Claude.ai + *.claude.com. We allow any URL that contains
    // one of the known SEND verbs (completion, append_message,
    // retry_completion, chat_conversations, send_message, messages,
    // send) so projects / artifact / v2 API endpoints are covered as
    // they roll out. The deny-list removes POSTs that carry no user
    // text (rename, feedback, share, etc.). The final authoritative
    // gate is extractInputs(): if the body has no messages[].content
    // / prompt / text, processBody early-returns without UI.
    match: (url) =>
      /(^https?:\/\/claude\.(ai|com)|\.claude\.com)/.test(url) &&
      /\/(?:completion|append_message|retry_completion|chat_conversations|send_message|messages|send)(?=[/?#]|$)/.test(
        url
      ) &&
      !/\/(?:title|feedback|star|archive|share|export|leave|rename|latest|preview|render_status|count|stream_events|usage|analytics|telemetry|ratings)(?=[/?#]|$)/.test(
        url
      ),
    extractInputs(body) {
      const out = [];
      // Legacy "prompt" field (still used by /append_message).
      if (typeof body?.prompt === "string" && body.prompt.trim()) {
        out.push(body.prompt);
      }
      // Top-level "text" / "query" / "message" fields used by newer
      // send_message variants.
      for (const k of ["text", "query", "message"]) {
        if (typeof body?.[k] === "string" && body[k].trim()) {
          out.push(body[k]);
        }
      }
      if (Array.isArray(body?.messages)) {
        for (const m of body.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            out.push(m.content);
          } else if (Array.isArray(m?.content)) {
            for (const p of m.content) {
              if (p?.type === "text" && typeof p.text === "string") {
                out.push(p.text);
              }
            }
          }
        }
      }
      // Some Claude endpoints wrap the user content under
      // "parent_message_uuid" + "content": [{type, text}]. Treat
      // top-level content[] the same way.
      if (Array.isArray(body?.content)) {
        for (const p of body.content) {
          if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
            out.push(p.text);
          }
        }
      }
      return out;
    },
    replaceInputs(body, masked) {
      let i = 0;
      const next = (orig) => (i < masked.length ? masked[i++] : orig);
      const clone = JSON.parse(JSON.stringify(body));
      if (typeof clone?.prompt === "string" && clone.prompt.trim()) {
        clone.prompt = next(clone.prompt);
      }
      for (const k of ["text", "query", "message"]) {
        if (typeof clone?.[k] === "string" && clone[k].trim()) {
          clone[k] = next(clone[k]);
        }
      }
      if (Array.isArray(clone?.messages)) {
        for (const m of clone.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            m.content = next(m.content);
          } else if (Array.isArray(m?.content)) {
            for (const p of m.content) {
              if (p?.type === "text" && typeof p.text === "string") {
                p.text = next(p.text);
              }
            }
          }
        }
      }
      if (Array.isArray(clone?.content)) {
        for (const p of clone.content) {
          if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
            p.text = next(p.text);
          }
        }
      }
      return clone;
    },
  };

  const chatgptAdapter = {
    name: "chatgpt",
    // ChatGPT's chat send is `POST /backend-api/conversation` (or the
    // `/backend-api/f/conversation` moderation variant). Any longer
    // sub-path like `.../{id}/title` or `.../{id}/feedback` is NOT a
    // send. We allow optional query/hash, and rely on extractInputs
    // as the final gate.
    match: (url) =>
      /(chatgpt\.com|chat\.openai\.com)/.test(url) &&
      /\/backend-api\/(?:f\/)?conversation(?:\?[^#]*)?(?:#.*)?$/.test(url),
    extractInputs(body) {
      const out = [];
      if (Array.isArray(body?.messages)) {
        for (const m of body.messages) {
          if (m?.author?.role === "user" && Array.isArray(m?.content?.parts)) {
            for (const p of m.content.parts) {
              if (typeof p === "string" && p.trim()) out.push(p);
            }
          }
        }
      }
      return out;
    },
    replaceInputs(body, masked) {
      let i = 0;
      const next = (orig) => (i < masked.length ? masked[i++] : orig);
      const clone = JSON.parse(JSON.stringify(body));
      if (Array.isArray(clone?.messages)) {
        for (const m of clone.messages) {
          if (m?.author?.role === "user" && Array.isArray(m?.content?.parts)) {
            m.content.parts = m.content.parts.map((p) =>
              typeof p === "string" && p.trim() ? next(p) : p
            );
          }
        }
      }
      return clone;
    },
  };

  const geminiAdapter = {
    name: "gemini",
    match: (url) =>
      /gemini\.google\.com/.test(url) &&
      /(StreamGenerate|GenerateContent|assistant\.lamda|BardFrontendService)/i.test(
        url
      ),
    extractInputs(body) {
      const out = [];
      if (Array.isArray(body?.contents)) {
        for (const c of body.contents) {
          if ((c?.role === "user" || !c?.role) && Array.isArray(c?.parts)) {
            for (const p of c.parts) {
              if (typeof p?.text === "string" && p.text.trim()) out.push(p.text);
            }
          }
        }
      }
      if (typeof body?.["f.req"] === "string") {
        try {
          const parsed = JSON.parse(body["f.req"]);
          const walk = (v) => {
            if (typeof v === "string" && v.trim()) out.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
          };
          walk(parsed);
        } catch (_) {
          // Not JSON — ignore.
        }
      }
      return out;
    },
    replaceInputs(body, masked) {
      let i = 0;
      const next = (orig) => (i < masked.length ? masked[i++] : orig);
      const clone = JSON.parse(JSON.stringify(body));
      if (Array.isArray(clone?.contents)) {
        for (const c of clone.contents) {
          if ((c?.role === "user" || !c?.role) && Array.isArray(c?.parts)) {
            for (const p of c.parts) {
              if (typeof p?.text === "string" && p.text.trim()) {
                p.text = next(p.text);
              }
            }
          }
        }
      }
      return clone;
    },
  };

  // Manus is operated by Butterfly Effect Inc.; its backend APIs are
  // served from *.butterfly-effect.dev, not only from manus.im. The
  // user-facing page at manus.im fetches chat/session endpoints from
  // butterfly-effect.dev, so a ``manus.im``-only matcher never fires.
  // Match either host, then gate on a common API path keyword to keep
  // out static assets and telemetry.
  const manusAdapter = {
    name: "manus",
    // Keep a broad SEND-intent regex with exclusions for non-chat
    // sub-paths. Manus's API surface shifts often (butterfly-effect
    // vs manus.im) and the bulk of their chat traffic is over the
    // Socket.IO WebSocket, so the fetch/XHR matcher here is a safety
    // net only. extractInputs is the authoritative gate.
    match: (url) =>
      /(manus\.im|butterfly-effect\.dev)/i.test(url) &&
      !/(sentry|amplitude|analytics|telemetry|segment\.io|datadog|newrelic)/i.test(
        url
      ) &&
      /\/(?:submit|send|message|messages|completion|chat|rpc|prompt|task|agent|conversation|conversations)(?=[/?#]|$)/i.test(
        url
      ) &&
      !/\/(?:files?|list|search|feedback|metrics|status|health|heartbeat|preview|thumbnail|avatar|upload)(?=[/?#]|$)/i.test(
        url
      ),
    extractInputs(body) {
      const out = [];
      const pushIfString = (v) => {
        if (typeof v === "string" && v.trim()) out.push(v);
      };
      pushIfString(body?.input);
      pushIfString(body?.prompt);
      pushIfString(body?.query);
      pushIfString(body?.text);
      pushIfString(body?.message);
      pushIfString(body?.content);
      if (Array.isArray(body?.contents)) {
        for (const c of body.contents) {
          if (c?.type === "text" && typeof c.value === "string" && c.value.trim()) {
            out.push(c.value);
          }
        }
      }
      if (Array.isArray(body?.messages)) {
        for (const m of body.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            out.push(m.content);
          } else if (Array.isArray(m?.content)) {
            for (const p of m.content) {
              if (typeof p?.text === "string" && p.text.trim()) out.push(p.text);
            }
          }
        }
      }
      return out;
    },
    replaceInputs(body, masked) {
      let i = 0;
      const next = (orig) => (i < masked.length ? masked[i++] : orig);
      const clone = JSON.parse(JSON.stringify(body));
      const swap = (key) => {
        if (typeof clone?.[key] === "string" && clone[key].trim()) {
          clone[key] = next(clone[key]);
        }
      };
      swap("input");
      swap("prompt");
      swap("query");
      swap("text");
      swap("message");
      swap("content");
      if (Array.isArray(clone?.contents)) {
        for (const c of clone.contents) {
          if (c?.type === "text" && typeof c.value === "string" && c.value.trim()) {
            c.value = next(c.value);
          }
        }
      }
      if (Array.isArray(clone?.messages)) {
        for (const m of clone.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            m.content = next(m.content);
          } else if (Array.isArray(m?.content)) {
            for (const p of m.content) {
              if (typeof p?.text === "string" && p.text.trim()) {
                p.text = next(p.text);
              }
            }
          }
        }
      }
      return clone;
    },
  };

  const SERVICES = [claudeAdapter, chatgptAdapter, geminiAdapter, manusAdapter];

  function pickAdapter(url) {
    if (typeof url !== "string") return null;
    for (const s of SERVICES) {
      try {
        if (s.match(url)) {
          // F-SC-11: Secure Composer がこのタブの ChatGPT 入力を受け持っているときは、
          // ネイティブ送信には既にマスク済み本文が載っている。ここで横取りすると、
          // 二重にサイドバー確認が出たり、再試行の再送で経路が食い違う。SC を唯一の
          // 経路にするため、chatgpt アダプタは素通しする (他プロバイダ・SC 無効時は従来どおり)。
          if (s.name === "chatgpt" && NS.settings && NS.settings.scOwnsComposer) return null;
          return s;
        }
      } catch (_) {
        // Broken matcher → skip, never brick the page.
      }
    }
    return null;
  }

  function confirmSendUnmasked(serviceName) {
    try {
      return window.confirm(
        `[PII Guard] Could not mask your input to ${serviceName}.\n\n` +
          `Send the original text anyway?`
      );
    } catch (_) {
      return false;
    }
  }

  // Apply the subset of gateway detections that the user kept
  // checked in the review modal. We use the numbered-tag strategy
  // (``<ENTITY_TYPE_N>``) so repeated mentions of the same surface
  // share a placeholder, matching the server-side invariant.
  function applyTagSubstitutions(originalText, detections, keptIds) {
    if (!keptIds || keptIds.size === 0) return originalText;
    const kept = detections.filter((_, idx) => keptIds.has(idx));
    return maskSpans(originalText, kept);
  }

  // 伏せる範囲を伏せ字に置き換える。重なる範囲のまとめ方は
  // engine/aggregate.js の applySpans() を参照 (1.5.1)。エンジンが無いまま
  // 伏せずに送ることはしない — 送信ごと止める。
  function maskSpans(originalText, spans) {
    const agg = NS.engine && NS.engine.aggregate;
    if (!agg || typeof agg.applySpans !== "function") {
      throw new Error("mask-mcp: engine not ready — refusing to send unmasked text");
    }
    return agg.applySpans(originalText, spans);
  }

  // Sidebar variant: input is the flattened [start, end, label] list
  // returned from sidebar.show(). Same contract as
  // applyTagSubstitutions; kept as a separate function so injected.js
  // never imports from the sidebar global (the sidebar may legitimately
  // be missing if the user picked ``uiMode: "modal"`` and only
  // review-modal.js was loaded).
  // Post-process LLM replace-mode output so every distinct original
  // value gets a UNIQUE numbered tag (<name_1>, <name_2>, <company_1>, …).
  // This is what makes restoration possible later: the extension can
  // map <name_3> → "田中副社長" unambiguously because the mapping is
  // 1:1, not 1:N. The same surface text reused within one message
  // keeps the same tag so references stay consistent.
  //
  // Strategy:
  //   1. Walk LLM.replacements in order, derive a base tag ("name",
  //      "company", …) from each replacement string ("<name>" or
  //      entity_type lowercase).
  //   2. Assign <base_N> where N is 1-based per-base counter; same
  //      original gets the same tag.
  //   3. Rebuild rewritten_text by locating every occurrence of
  //      every tagged original in the source text and splicing in
  //      its tag. Longest-first greedy to avoid clobbering longer
  //      matches that contain shorter ones.
  function applyUniqueTagsToReplace(originalText, replacements) {
    const BASE_FROM_LABEL = {
      PERSON: "name",
      COMPANY: "company",
      LOCATION: "location",
      DEPARTMENT: "department",
      PROJECT_CODE: "project",
      CREDENTIAL: "credential",
      SENSITIVE_FACT: "fact",
      PHONE_NUMBER: "phone",
      EMAIL_ADDRESS: "email",
    };
    const tagByOriginal = new Map();
    const counters = {};
    for (const r of replacements) {
      const orig = typeof r?.original === "string" ? r.original.trim() : "";
      if (!orig || tagByOriginal.has(orig)) continue;
      // Prefer the LLM-picked base tag (e.g. <hospital> inside
      // <hospital> or "元<company>"), but fall back to the label
      // mapping if the replacement wasn't a recognizable tag.
      let base;
      const tagMatch = String(r.replacement || "").match(
        /<([a-z][a-z_]*?)(?:_\d+)?>/i
      );
      if (tagMatch) {
        base = tagMatch[1].toLowerCase();
      } else {
        base =
          BASE_FROM_LABEL[String(r.entity_type || "").toUpperCase()] ||
          "masked";
      }
      counters[base] = (counters[base] || 0) + 1;
      tagByOriginal.set(orig, `<${base}_${counters[base]}>`);
    }
    // Rebuild rewritten_text — match every tagged original against
    // the source, resolve overlaps by longest-first, splice tags in.
    const hits = [];
    for (const orig of tagByOriginal.keys()) {
      let from = 0;
      while (true) {
        const idx = originalText.indexOf(orig, from);
        if (idx < 0) break;
        hits.push({ start: idx, end: idx + orig.length, orig });
        from = idx + orig.length;
      }
    }
    hits.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return b.end - b.start - (a.end - a.start);
    });
    const chosen = [];
    let lastEnd = -1;
    for (const h of hits) {
      if (h.start >= lastEnd) {
        chosen.push(h);
        lastEnd = h.end;
      }
    }
    let out = "";
    let cursor = 0;
    for (const h of chosen) {
      out += originalText.slice(cursor, h.start);
      out += tagByOriginal.get(h.orig);
      cursor = h.end;
    }
    out += originalText.slice(cursor);

    const uniqueReplacements = [];
    const seen = new Set();
    for (const r of replacements) {
      const orig = typeof r?.original === "string" ? r.original.trim() : "";
      if (!orig || seen.has(orig)) continue;
      seen.add(orig);
      uniqueReplacements.push({
        original: orig,
        replacement: tagByOriginal.get(orig),
        entity_type: r.entity_type,
      });
    }
    return { rewritten_text: out, replacements: uniqueReplacements };
  }

  function applyTriples(originalText, triples) {
    if (!triples || triples.length === 0) return originalText;
    return maskSpans(originalText, triples);
  }

  async function processBody(adapter, bodyJson, url) {
    const inputs = adapter.extractInputs(bodyJson);
    if (!inputs.length) {
      // Log once per adapter/URL so when a site adds a new body shape
      // that extractInputs doesn't recognise, the user can paste this
      // log line back to us for fixing.
      logOnce(
        `${adapter.name}: adapter matched but body had no user text —`
          + " keys: " + Object.keys(bodyJson || {}).slice(0, 8).join(","),
        url,
      );
      return { changed: false, body: bodyJson };
    }
    LOG(`${adapter.name}: ${inputs.length} input string(s) to mask`);

    // v0.5.0 — AI replace mode. The LLM rewrites each input into
    // <tag_N> placeholders. We open the review sidebar IMMEDIATELY
    // with an overlay, run the LLM as opts.llmPending, then display
    // the rewritten rows for user confirmation. No page-center
    // overlay — everything happens inside the sidebar.
    try {
      const cfgResp = await request("llm-config", {});
      const cfg = cfgResp && cfgResp.config;
      if (cfg && cfg.mode === "replace") {
        const sidebarNS = NS.sidebar;
        const wantReview =
          NS.settings && NS.settings.interactive !== false;
        if (wantReview && sidebarNS && inputs.length > 0) {
          const LBL2CAT = {
            PERSON: "PERSON",
            COMPANY: "ORGANIZATION",
            LOCATION: "LOCATION",
            DEPARTMENT: "OTHER",
            PROJECT_CODE: "OTHER",
            CREDENTIAL: "CREDENTIAL",
            SENSITIVE_FACT: "OTHER",
            EMAIL_ADDRESS: "CONTACT",
            PHONE_NUMBER: "CONTACT",
          };
          const LBL2SEV = {
            PERSON: "critical",
            COMPANY: "critical",
            LOCATION: "high",
            DEPARTMENT: "medium",
            PROJECT_CODE: "medium",
            CREDENTIAL: "critical",
            SENSITIVE_FACT: "high",
            EMAIL_ADDRESS: "critical",
            PHONE_NUMBER: "high",
          };
          const text0 = inputs[0];
          // Closure holds the rewritten texts + whether LLM succeeded
          // for every input. Populated by the llmPending promise; read
          // after sidebar.show returns.
          const replaceResult = { rewritten: [], ok: true };
          const llmPromise = (async () => {
            for (const text of inputs) {
              const out = await llmAugment(text, "replace");
              if (
                out &&
                typeof out.rewritten_text === "string" &&
                out.rewritten_text.length > 0 &&
                out.rewritten_text !== text
              ) {
                const normalized = applyUniqueTagsToReplace(
                  text,
                  Array.isArray(out.replacements) ? out.replacements : [],
                );
                replaceResult.rewritten.push(normalized.rewritten_text);
                if (text === text0) replaceResult.replacements0 = normalized.replacements;
              } else {
                replaceResult.ok = false;
                break;
              }
            }
            // Build synthetic aggregated for the first input so the
            // sidebar can render the rows. Multi-input bodies trust
            // the first one's review.
            const reps0 = replaceResult.replacements0 || [];
            const rows = [];
            for (const r of reps0) {
              const orig = typeof r.original === "string" ? r.original : "";
              if (!orig) continue;
              const start = text0.indexOf(orig);
              if (start < 0) continue;
              const label = String(r.entity_type || "SENSITIVE_FACT").toUpperCase();
              rows.push({
                value: orig,
                label,
                category: LBL2CAT[label] || "OTHER",
                count: 1,
                positions: [[start, start + orig.length]],
                masked: true,
                placeholder: String(r.replacement || `<${label}>`),
                classification: "contextual",
                severity: LBL2SEV[label] || "medium",
                source: "llm",
              });
            }
            return {
              original_text: text0,
              aggregated: rows,
              audit_id: "",
              force_masked_categories: [],
              _llmStatus: replaceResult.ok && rows.length > 0
                ? "ok_entities"
                : replaceResult.ok
                  ? "ok_empty"
                  : "failed",
            };
          })();

          // Open sidebar with empty initial data + the pending
          // promise. The in-sidebar overlay shows "AI 置換中…" until
          // llmPromise resolves with the rewritten rows.
          const emptyAgg = {
            original_text: text0,
            aggregated: [],
            audit_id: "",
            force_masked_categories: [],
          };
          const decision = await sidebarNS.show(emptyAgg, text0, {
            llmPending: llmPromise,
            mode: "replace",
          });
          if (!decision.accepted) {
            throw new Error("mask-mcp: user cancelled review");
          }
          if (replaceResult.ok && replaceResult.rewritten.length === inputs.length) {
            LOG(`${adapter.name}: LLM replace mode substituted ${inputs.length} input(s)`);
            return {
              changed: true,
              body: adapter.replaceInputs(bodyJson, replaceResult.rewritten),
            };
          }
          LOG(`${adapter.name}: LLM replace partial/failed; falling back to regex path`);
        }
      }
    } catch (err) {
      if (err && err.message && err.message.includes("mask-mcp: user cancelled")) {
        throw err;
      }
      WARN("llm replace path failed; falling back to regex:", err?.message || err);
    }

    const interactive = NS.settings && NS.settings.interactive !== false;
    const uiMode = (NS.settings && NS.settings.uiMode) || "sidebar";
    const sidebar = NS.sidebar;
    const modal = NS.reviewModal;
    // Dispatch policy:
    //   * interactive off  → auto-mask via /sanitize, no UI.
    //   * interactive on + uiMode "sidebar" + sidebar loaded
    //                       → /sanitize/aggregated + sidebar.show().
    //   * interactive on + uiMode "modal"  + modal loaded
    //                       → /sanitize + reviewModal.show() (legacy).
    //   * any other combo (UI helper missing) → fall back to auto-mask.
    const useSidebar = interactive && uiMode === "sidebar" && !!sidebar;
    const useModal = interactive && uiMode === "modal" && !!modal;

    // When LLM is enabled we take it as the authoritative detector
    // and ALWAYS open the sidebar with the overlay, even when the
    // regex layer returned 0 hits. Cached once per batch so every
    // input in a multi-message send uses the same decision.
    let llmEnabled = false;
    try {
      const cfgResp = await request("llm-config", {});
      llmEnabled = !!(cfgResp && cfgResp.config);
    } catch (_) {
      llmEnabled = false;
    }

    const masked = [];
    let totalDetections = 0;
    let anyChanged = false;
    for (const text of inputs) {
      if (useSidebar) {
        let aggResp = await sanitizeAggregated(text, adapter.name, url);
        if (!aggResp) {
          if (!confirmSendUnmasked(adapter.name)) {
            throw new Error("mask-mcp: user cancelled unmasked send");
          }
          masked.push(text);
          continue;
        }
        // Dispatch based on whether the local LLM is enabled:
        //   * LLM ON  → open sidebar + overlay IMMEDIATELY, regardless
        //     of regex count. LLM is authoritative. The sidebar itself
        //     auto-closes silently if the merged result is empty.
        //   * LLM OFF → behave as before. If regex returned 0 rows
        //     we forward the text untouched (no sidebar flash).
        const initialAgg = Array.isArray(aggResp.aggregated)
          ? aggResp.aggregated
          : [];
        let decision;
        if (llmEnabled) {
          const llmPromise = mergeLlmDetect(aggResp, text);
          decision = await sidebar.show(aggResp, text, {
            llmPending: llmPromise,
            mode: "detect",
          });
        } else if (initialAgg.length > 0) {
          decision = await sidebar.show(aggResp, text, { mode: "regex" });
        } else {
          // Neither regex nor LLM has anything for us — forward.
          masked.push(text);
          continue;
        }
        if (!decision.accepted) {
          throw new Error("mask-mcp: user cancelled review");
        }
        const finalText = applyTriples(text, decision.maskedPositions);
        if (finalText !== text) anyChanged = true;
        masked.push(finalText);
        totalDetections += decision.maskedPositions
          ? decision.maskedPositions.length
          : 0;
        continue;
      }

      const result = await sanitizeOnce(text, adapter.name, url);
      if (!result) {
        if (!confirmSendUnmasked(adapter.name)) {
          throw new Error("mask-mcp: user cancelled unmasked send");
        }
        masked.push(text);
        continue;
      }

      const detections = Array.isArray(result.detections)
        ? result.detections
        : [];

      if (useModal && detections.length > 0) {
        const decision = await modal.show(detections, text);
        if (!decision.accepted) {
          // Cancelled — abort the whole outbound request. The fetch
          // hook translates this exception into a rejected Promise
          // so the page's send logic sees a normal network error.
          throw new Error("mask-mcp: user cancelled review");
        }
        const finalText = applyTagSubstitutions(
          text,
          detections,
          decision.maskedDetectionIds
        );
        if (finalText !== text) anyChanged = true;
        masked.push(finalText);
        totalDetections += decision.maskedDetectionIds.size;
        continue;
      }

      // Auto-mask path (interactive off, no UI helper loaded, or no
      // detections) — use the gateway-sanitised text as-is.
      if (result.sanitized_text !== text) anyChanged = true;
      masked.push(result.sanitized_text);
      totalDetections += detections.length;
    }

    reportDetectionCount(totalDetections);

    if (!anyChanged) {
      return { changed: false, body: bodyJson };
    }
    return { changed: true, body: adapter.replaceInputs(bodyJson, masked) };
  }

  // --- 原文の持ち出しガード (F-EG-01〜04) ------------------------------------
  //
  // security/egress-guard.js (content.js がこのファイルより先に注入) の関数で:
  //   (1) 形を知っている送信 (Claude の PerformAction = protobuf、Gemini の processSession =
  //       WebChannel) は、本文を取り出して processBody (確認画面とマスク) に載せる。
  //   (2) それ以外のすべての通信 (fetch / XHR / sendBeacon / WebSocket、どの宛先でも) で、
  //       利用者が打った・貼った文字から検出した値が入っていたら伏せ字にするか止める。
  //       外部 (サイト自身以外) の宛先なら、下書きの一部 (16 文字以上) が入っているだけでも止める。
  // 2026-10-18 実測: Claude と Gemini は送信の形が変わって従来のアダプタが黙って素通しになり、
  // Manus は Amplitude がクリックした入力欄の文字を送っていた。サイトがまた形を変えても、
  // (2) が受け止めて素通しではなく止める側に倒す。マスキング OFF のときは何もしない。
  const EG = NS.egress || null;
  const PAGE_HOST = location.hostname;
  const isFirstParty = EG ? EG.firstPartyFor(PAGE_HOST) : () => true;
  const guard = {
    sensitive: EG ? EG.createSensitiveSet() : null,
    live: new Map(),       // 入力欄 → 今の文字
    history: [],           // 以前の文字 (消えた・送った・貼った文字) {t, text}
    grams: null,           // 下書きの断片 (遅延計算)
    timers: new WeakMap(),
    lastNotice: 0,
    noticeCount: 0,
  };
  const HISTORY_MAX = 30;
  const HISTORY_TTL = 30 * 60 * 1000;
  // 前に覚えた記憶 (読み直しの前に検出した値・下書き) を content script 経由で受け取る。
  // 受け取るまで (最大 1.5 秒) は、非同期で待てる通信 (fetch / XHR) の判定を待たせる。
  let readyResolve = null;
  guard.ready = new Promise((res) => { readyResolve = res; });
  setTimeout(() => readyResolve && readyResolve(), 1500);
  NS.__egressRestore = (data) => {
    for (const v of Array.isArray(data.values) ? data.values : []) if (v && typeof v.v === "string") guard.sensitive && guard.sensitive.add(v.v, v.label);
    for (const d of Array.isArray(data.drafts) ? data.drafts : []) if (typeof d === "string") pushHistory(d, true);
    if (readyResolve) { readyResolve(); readyResolve = null; }
  };
  // 新しく覚えたものは、まとめて content script → SW に預ける
  const toRemember = { values: [], drafts: [], timer: 0 };
  function remember(kind, item) {
    toRemember[kind].push(item);
    if (toRemember.timer) return;
    toRemember.timer = setTimeout(() => {
      const msg = { source: TAG_IN, type: "egress-remember", values: toRemember.values.splice(0), drafts: toRemember.drafts.splice(0) };
      toRemember.timer = 0;
      try { window.postMessage(msg, "*"); } catch (_) {}
    }, 800);
  }
  const maskingOn = () => !(NS.settings && NS.settings.enabled === false);
  const guardActive = () =>
    !!EG && maskingOn() && (guard.sensitive.size > 0 || guard.live.size > 0 || guard.history.length > 0);

  function pushHistory(text, restoring) {
    const t = String(text || "").trim();
    if (!t) return;
    if (guard.history.length && guard.history[0].text === t) return;
    guard.history = [{ t: Date.now(), text: t }, ...guard.history.filter((h) => h.text !== t && !t.startsWith(h.text))].slice(0, HISTORY_MAX);
    guard.grams = null;
    if (!restoring) remember("drafts", t);
  }
  function draftsNow() {
    const now = Date.now();
    const before = guard.history.length;
    guard.history = guard.history.filter((h) => now - h.t < HISTORY_TTL);
    if (guard.history.length !== before) guard.grams = null;
    const out = [];
    for (const [el, t] of guard.live) {
      if (!el.isConnected) { guard.live.delete(el); pushHistory(t); continue; }
      if (t && t.trim()) out.push(t);
    }
    for (const h of guard.history) out.push(h.text);
    return out;
  }
  // 入力の根元 (textarea / テキストの input / contenteditable の一番外側)
  function editableRoot(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el) return null;
    if (el.tagName === "TEXTAREA") return el;
    if (el.tagName === "INPUT") return /^(text|search|email|tel|url)?$/i.test(el.getAttribute("type") || "") ? el : null;
    let root = null;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) if (cur.isContentEditable) root = cur;
    return root;
  }
  const textOf = (el) => String((el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.innerText) || "");
  async function detectInto(text) {
    if (!EG || !maskingOn() || !text || !text.trim()) return;
    try {
      // 常に伏せる語も覚えるため、ISOLATED のエンジン (リスト込み) を先に使う
      let r = await localMask("sanitize", text);
      if (!r) { const engine = await getEngine(); if (!engine) return; r = await engine.maskSanitize(text, engineOpts()); }
      for (const d of (r && r.detections) || []) {
        const v = typeof d.text === "string" ? d.text : text.slice(d.start, d.end);
        const before = guard.sensitive.size;
        guard.sensitive.add(v, d.entity_type);
        if (guard.sensitive.size !== before) remember("values", { v, label: d.entity_type });
      }
    } catch (_) { /* 検出できなかった分は、外部宛ての下書きの断片の照合だけが効く */ }
  }
  function track(el) {
    const prev = guard.live.has(el) ? guard.live.get(el) : null;
    const t = textOf(el);
    if (t === prev) return;
    if (prev && prev.trim() && !t.startsWith(prev.trim())) pushHistory(prev); // 消えた・書き換えた前の文字も覚える
    guard.live.set(el, t);
    guard.grams = null;
    clearTimeout(guard.timers.get(el));
    guard.timers.set(el, setTimeout(() => { detectInto(t); if (t.trim().length >= 16) remember("drafts", t.trim()); }, 200));
  }
  if (EG) {
    try { window.postMessage({ source: TAG_IN, type: "egress-restore-request" }, "*"); } catch (_) {}
    const onEdit = (e) => { const el = editableRoot(e.target); if (el) track(el); };
    document.addEventListener("input", onEdit, true);
    document.addEventListener("compositionend", onEdit, true);
    // 貼った文字・落とした文字 (入力欄に入らず添付に変わるサイトもあるので、ここで覚える)
    document.addEventListener("paste", (e) => {
      try { const t = e.clipboardData && e.clipboardData.getData("text/plain"); if (t) { pushHistory(t); detectInto(t); } } catch (_) {}
    }, true);
    document.addEventListener("drop", (e) => {
      try { const t = e.dataTransfer && e.dataTransfer.getData("text/plain"); if (t) { pushHistory(t); detectInto(t); } } catch (_) {}
    }, true);
    // プログラムで入った文字 (下書きの復元など) も拾う
    setInterval(() => {
      if (!maskingOn()) return;
      for (const el of document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')) {
        if (el.parentElement && el.parentElement.isContentEditable) continue;
        track(el);
      }
    }, 3000);
  }

  function notifyGuard(r, url) {
    LOG(`egress guard: ${r.action} ${redactUrl(url)} (${r.reason || "scrubbed"})`);
    guard.noticeCount++;
    const now = Date.now();
    if (now - guard.lastNotice < 15000) return; // ピルへの通知はまとめる
    guard.lastNotice = now;
    try {
      window.dispatchEvent(new CustomEvent("mask-mcp:egress", { detail: JSON.stringify({ action: r.action, reason: r.reason || "", count: guard.noticeCount }) }));
    } catch (_) {}
    guard.noticeCount = 0;
  }
  /** 通信 1 件の判定。body は {text} | {bytes} | {unreadable:true} */
  function guardDecide(url, body) {
    let host = "";
    try { host = new URL(url, location.href).hostname; } catch (_) {}
    const drafts = draftsNow();
    if (!guard.grams) guard.grams = EG.draftGrams(drafts, 16);
    const r = EG.decide({ url, host, ...body }, { sensitive: guard.sensitive, drafts, firstParty: isFirstParty, grams: guard.grams, echoMin: 16 });
    if (r.action !== "pass") notifyGuard(r, url);
    return r;
  }
  const BLOCKED = () => new TypeError("PII Guard: blocked a request carrying unmasked personal data");
  // 止めた fetch: 外部 (解析ツール等) 宛てなら「送れた」(200) と返し、イベントを保存して送り直させない。
  // サイト自身宛てはネットワークエラーとして見せる (アプリが成功と勘違いしないように)。
  function blockedFetch(url) {
    let host = "";
    try { host = new URL(url, location.href).hostname; } catch (_) {}
    if (host && !isFirstParty(host)) {
      return Promise.resolve(new Response('{"code":200}', { status: 200, headers: { "content-type": "application/json" } }));
    }
    return Promise.reject(BLOCKED());
  }

  // 形を知っている送信: 本文を取り出して processBody (確認画面とマスク) に載せ、本文以外の
  // フィールドに残る検出済みの値も伏せる。本文が無い (入力中の通信など) なら null。
  async function maskKnownSend(adapter, raw, url) {
    const model = adapter.decode(raw, draftsNow());
    if (!model || !model.fields.length) return null;
    const result = await processBody(adapter, model, url); // 取消は例外で上へ
    let m = result.changed ? result.body : model;
    // 添付 (中身・ファイル名) は確認画面を出さずに自動でマスクする。マスクできなければ送らない
    if (typeof adapter.autoFields === "function") {
      for (const f of adapter.autoFields(m)) {
        const r = await sanitizeOnce(f.text, adapter.name, url);
        if (!r || typeof r.sanitized_text !== "string") return { blocked: true };
        let t = r.sanitized_text;
        if (f.kind === "name") t = t.replace(/</g, "[").replace(/>/g, "]"); // ファイル名に < > は使わない
        if (t !== f.text) { m = adapter.setField(m, f.path, t); LOG(`${adapter.name}: masked an attachment ${f.kind}`); }
      }
    }
    const other = adapter.scrubOthers(m, guard.sensitive);
    if (other.stuck) return { blocked: true };
    if (result.changed) LOG(`${adapter.name}: substituted masked body`);
    return { body: adapter.encode(other.model) };
  }

  // fetch の本文を読む (Request の本文も)。書き換えた本文で組み直す関数を添える
  async function readFetchBody(input, init) {
    const hasInit = !!(init && init.body != null);
    const remake = (nb) => (hasInit ? [input, { ...init, body: nb }] : [new Request(input, { body: nb }), init]);
    if (hasInit) {
      const b = init.body;
      if (typeof b === "string") return { text: b, rebuild: remake };
      if (b instanceof URLSearchParams) return { text: b.toString(), rebuild: (nb) => remake(new URLSearchParams(nb)) };
      if (b instanceof ArrayBuffer) return { bytes: new Uint8Array(b), rebuild: remake };
      if (ArrayBuffer.isView(b)) return { bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength), rebuild: remake };
      if (b instanceof Blob) {
        const u = new Uint8Array(await b.arrayBuffer());
        return { bytes: u, rebuild: (nb) => remake(new Blob([nb], { type: b.type })) };
      }
      if (b instanceof FormData) return { ...formDataText(b), rebuild: null };
      return { unreadable: true, rebuild: null };
    }
    if (typeof Request !== "undefined" && input instanceof Request && !/^(GET|HEAD)$/i.test(input.method)) {
      try { return { bytes: new Uint8Array(await input.clone().arrayBuffer()), rebuild: remake }; }
      catch (_) { return { unreadable: true, rebuild: null }; }
    }
    return { text: "", rebuild: null };
  }
  function formDataText(fd) {
    let s = "";
    let file = false;
    for (const [k, v] of fd.entries()) { if (typeof v === "string") s += `${k}=${v}\n`; else file = true; }
    return file && !s ? { unreadable: true } : { text: s };
  }
  function syncBody(data) {
    if (data == null) return { text: "" };
    if (typeof data === "string") return { text: data };
    if (data instanceof URLSearchParams) return { text: data.toString(), form: true };
    if (data instanceof ArrayBuffer) return { bytes: new Uint8Array(data) };
    if (ArrayBuffer.isView(data)) return { bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    if (data instanceof FormData) return formDataText(data);
    return { unreadable: true }; // Blob などは同期では読めない
  }
  // 止めた XHR は、ネットワークエラーと同じ見え方にする
  function failXhr(xhr) {
    setTimeout(() => {
      try { xhr.dispatchEvent(new ProgressEvent("error")); } catch (_) {}
      try { xhr.dispatchEvent(new ProgressEvent("loadend")); } catch (_) {}
    }, 0);
  }

  // --- ページにつながっていない file input (F-EG-05) --------------------------
  // 添付ガード (ISOLATED world の attachment-guard.js) は window の capture で change を受ける。
  // 作ってすぐ click する file input はページにつながっておらず、change が window に届かない。
  // click / showPicker の前に、見えない箱に入れてページへつなぐ (ページから見た動きは変わらない)。
  (function connectDetachedFileInputs() {
    let box = null;
    const connect = (el) => {
      try {
        if (el.type !== "file" || el.isConnected) return;
        if (!box || !box.isConnected) {
          box = document.createElement("div");
          box.setAttribute("data-pii-guard", "file-inputs");
          box.style.display = "none";
          (document.body || document.documentElement).appendChild(box);
        }
        box.appendChild(el);
      } catch (_) {}
    };
    const origClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { connect(this); return origClick.apply(this, arguments); };
    const origPicker = HTMLInputElement.prototype.showPicker;
    if (typeof origPicker === "function") {
      HTMLInputElement.prototype.showPicker = function () { connect(this); return origPicker.apply(this, arguments); };
    }
  })();

  // --- 投げ直した drop のファイルを、フォルダ対応の API でも読めるようにする (F-EG-05) -------
  // 添付ガードは、ページに渡す前にマスクした File を載せた drop を投げ直す (渡し先の input が無い
  // サイト)。スクリプトで作った DataTransfer の項目は webkitGetAsEntry() が null を返すので、それで
  // ファイルを数えるサイト (Gemini、2026-10-18 実測) は添付を捨てる。本物が null を返すファイル項目に
  // だけ、その File を返す最小のエントリを返す (OS からの本物のドロップは本物のエントリのまま)。
  if (typeof DataTransferItem !== "undefined" && typeof DataTransferItem.prototype.webkitGetAsEntry === "function") {
    const origGetAsEntry = DataTransferItem.prototype.webkitGetAsEntry;
    DataTransferItem.prototype.webkitGetAsEntry = function () {
      const real = origGetAsEntry.apply(this, arguments);
      if (real || this.kind !== "file") return real;
      const file = this.getAsFile();
      if (!file) return null;
      return {
        isFile: true, isDirectory: false, name: file.name, fullPath: "/" + file.name, filesystem: null,
        file(success, error) { try { success(file); } catch (e) { if (typeof error === "function") error(e); } },
        getParent(success) { if (typeof success === "function") success(null); },
      };
    };
  }

  // --- fetch hook --------------------------------------------------------

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function maskedFetch(input, init) {
    try {
      const rawUrl =
        typeof input === "string"
          ? input
          : input && typeof input.url === "string"
          ? input.url
          : input && typeof input.href === "string"
          ? input.href
          : "";
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      // Resolve relative URLs (e.g. fetch("/api/...")) to absolute
      // BEFORE adapter matching. Without this, claude.ai's SPA — which
      // uses relative paths like ``/api/organizations/.../completion``
      // — never matched the ^https?://claude.(ai|com)/ anchor.
      let url = rawUrl;
      try {
        url = new URL(rawUrl, location.href).toString();
      } catch (_) {
        // Malformed URL → keep the raw string; adapter will just miss.
      }

      // (1) 従来の JSON アダプタ (送信の本文を確認画面とマスクに載せる)
      if (method === "POST") {
        const adapter = pickAdapter(url);
        // Diagnostic: when ANY claude.ai / chatgpt / gemini / manus
        // host POSTs, log once-per-unique URL so users can debug
        // "sidebar never opens" by checking what endpoint the chat
        // app actually hits. Deduped so chat polling doesn't flood.
        try {
          const h = new URL(url, location.href).host;
          if (/(claude\.(ai|com)|\.claude\.com|chatgpt\.com|\.openai\.com|gemini\.google\.com|manus\.im|butterfly-effect\.dev)/i.test(h)) {
            logOnce(adapter ? "provider POST (adapter matched):" : "provider POST (NO adapter match):", url);
          }
        } catch (_) {}
        if (adapter) {
          const rawBody = init ? init.body : input && input.body;
          let parsed = null;
          if (typeof rawBody === "string") { try { parsed = JSON.parse(rawBody); } catch (_) { parsed = null; } }
          if (parsed) {
            if (!(await isEnabled())) return originalFetch(input, init);
            const result = await processBody(adapter, parsed, url);
            if (!result.changed) return originalFetch(input, init);
            const nextInit = { ...(init || {}) };
            nextInit.body = JSON.stringify(result.body);
            LOG(`${adapter.name}: substituted masked body`);
            return originalFetch(input, nextInit);
          }
        }
      }

      if (!EG || !maskingOn()) return originalFetch(input, init);
      await guard.ready;
      const known = method === "POST"
        ? (EG.adapters.claudeRpc.match(url) ? EG.adapters.claudeRpc : EG.adapters.geminiSession.match(url) ? EG.adapters.geminiSession : null)
        : null;
      if (!known && !guardActive()) return originalFetch(input, init);
      const body = await readFetchBody(input, init);

      // (2) 形を知っている送信 (protobuf / WebChannel)
      if (known) {
        const raw = known === EG.adapters.claudeRpc ? body.bytes : body.text;
        if (raw != null && (await isEnabled())) {
          const out = await maskKnownSend(known, raw, url);
          if (out && out.blocked) { notifyGuard({ action: "block", reason: "known-send-unscrubbable" }, url); return Promise.reject(BLOCKED()); }
          if (out) {
            if (!body.rebuild) return Promise.reject(BLOCKED());
            const [i2, n2] = body.rebuild(out.body);
            return originalFetch(i2, n2);
          }
        }
      }
      if (!guardActive()) return originalFetch(input, init);

      // (3) それ以外: 検出済みの値・(外部宛ての) 下書きの断片を探して、伏せるか止める
      const r = guardDecide(url, body.unreadable ? { unreadable: true } : body.bytes ? { bytes: body.bytes } : { text: body.text || "" });
      if (r.action === "pass") return originalFetch(input, init);
      if (r.action === "scrub" && body.rebuild) {
        const [i2, n2] = body.rebuild(r.text != null ? r.text : r.bytes);
        return originalFetch(i2, n2);
      }
      return blockedFetch(url);
    } catch (err) {
      if (err && err.message && err.message.includes("mask-mcp: user cancelled")) {
        LOG(err.message);
        // Surface as a rejected Promise so the page's send logic
        // treats it as a normal network failure (no masked payload
        // ever leaves the browser). Chat UIs typically present this
        // as "send failed — try again" which is the correct UX.
        return Promise.reject(err);
      }
      // [SECURITY] Fail-closed: if masking pipeline threw an unexpected
      // error we refuse the send rather than silently passing the
      // original (PII-bearing) body through. The AI service sees a
      // network error and the user sees the retry-prompt — the correct
      // UX for a privacy-critical tool.
      WARN("fetch hook error; ABORTING request (fail-closed):", err?.message || err);
      return Promise.reject(
        new TypeError("PII Guard: masking pipeline error; request aborted")
      );
    }
  };

  // --- XHR hook ----------------------------------------------------------

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this._maskMcpMethod = method;
    this._maskMcpUrl = url;
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    try {
      const method = String(this._maskMcpMethod || "GET").toUpperCase();
      const rawUrl = this._maskMcpUrl || "";
      // Resolve relative URL → absolute before adapter matching.
      let url = rawUrl;
      try {
        url = new URL(rawUrl, location.href).toString();
      } catch (_) {}
      const adapter = method === "POST" && typeof body === "string" ? pickAdapter(url) : null;
      // Diagnostic (deduped) for provider-host POSTs regardless of
      // adapter match, mirrors the fetch hook.
      if (method === "POST") {
        try {
          const h = new URL(url, location.href).host;
          if (/(claude\.(ai|com)|\.claude\.com|chatgpt\.com|\.openai\.com|gemini\.google\.com|manus\.im|butterfly-effect\.dev)/i.test(h)) {
            logOnce(adapter ? "provider XHR (adapter matched):" : "provider XHR (NO adapter match):", url);
          }
        } catch (_) {}
      }
      let parsed = null;
      if (adapter) { try { parsed = JSON.parse(body); } catch (_) { parsed = null; } }
      const on = !!EG && maskingOn();
      const known = !parsed && on && method === "POST"
        ? (EG.adapters.geminiSession.match(url) && typeof body === "string" ? EG.adapters.geminiSession
          : EG.adapters.claudeRpc.match(url) && body != null && typeof body !== "string" ? EG.adapters.claudeRpc : null)
        : null;
      if (!parsed && !known && !(on && guardActive())) {
        return originalXhrSend.apply(this, arguments);
      }
      // 形を知らない文字の本文は、その場で判定する (同期)
      if (!parsed && !known) {
        const sb = syncBody(body);
        if (!sb.unreadable && !sb.bytes) {
          const r = guardDecide(url, { text: sb.text });
          if (r.action === "pass") return originalXhrSend.apply(this, arguments);
          if (r.action === "scrub" && r.text != null && !(body instanceof FormData)) {
            return originalXhrSend.call(this, sb.form ? new URLSearchParams(r.text) : r.text);
          }
          failXhr(this);
          return;
        }
      }

      const xhr = this;
      const args = arguments;
      (async () => {
        try {
          if (parsed) {
            if (!(await isEnabled())) { originalXhrSend.apply(xhr, args); return; }
            const result = await processBody(adapter, parsed, url);
            if (!result.changed) { originalXhrSend.apply(xhr, args); return; }
            LOG(`${adapter.name}: substituted masked XHR body`);
            originalXhrSend.call(xhr, JSON.stringify(result.body));
            return;
          }
          let raw = null;
          let bytes = null;
          let rebuild = null;
          if (typeof body === "string") { raw = body; rebuild = (nb) => nb; }
          else if (body instanceof Blob) { bytes = new Uint8Array(await body.arrayBuffer()); rebuild = (nb) => new Blob([nb], { type: body.type }); }
          else {
            const sb = syncBody(body);
            if (sb.bytes) { bytes = sb.bytes; rebuild = (nb) => nb; }
            else if (sb.text != null) raw = sb.text;
          }
          if (known && (await isEnabled())) {
            const out = await maskKnownSend(known, known === EG.adapters.geminiSession ? raw : bytes, url);
            if (out && out.blocked) { notifyGuard({ action: "block", reason: "known-send-unscrubbable" }, url); failXhr(xhr); return; }
            if (out) { originalXhrSend.call(xhr, rebuild ? rebuild(out.body) : out.body); return; }
          }
          await guard.ready;
          if (!guardActive()) { originalXhrSend.apply(xhr, args); return; }
          const r = guardDecide(url, bytes ? { bytes } : raw != null ? { text: raw } : { unreadable: true });
          if (r.action === "pass") originalXhrSend.apply(xhr, args);
          else if (r.action === "scrub" && rebuild) originalXhrSend.call(xhr, rebuild(r.text != null ? r.text : r.bytes));
          else failXhr(xhr);
        } catch (err) {
          if (err && err.message && err.message.includes("mask-mcp: user cancelled")) {
            LOG(err.message);
            try { xhr.abort(); } catch (_) { /* noop */ }
            failXhr(xhr);
            return;
          }
          // [SECURITY] Fail-closed: never send the original body. Chat UIs
          // surface this as a send error.
          WARN("XHR hook error; ABORTING (fail-closed):", err?.message || err);
          try { xhr.abort(); } catch (_) { /* noop */ }
          failXhr(xhr);
        }
      })();
    } catch (err) {
      // [SECURITY] Outer setup error — also fail closed.
      WARN("XHR send hook setup failed; ABORTING:", err?.message || err);
      try { this.abort(); } catch (_) { /* noop */ }
      return;
    }
  };

  // --- sendBeacon hook ----------------------------------------------------
  //
  // Sentry / Amplitude SDKs routinely deliver envelopes via
  // ``navigator.sendBeacon`` which bypasses fetch+XHR entirely.
  // プロバイダ自身のホスト宛ては従来どおり一律に止める。それ以外 (外部の解析ツール等) は
  // 持ち出しガードで判定する (2026-10-18 実測: Manus の Amplitude は sendBeacon でも送る)。

  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function patchedSendBeacon(url, data) {
      try {
        const host = new URL(url, location.href).host;
        if (
          /(claude\.(ai|com)|\.claude\.com|chatgpt\.com|\.openai\.com|gemini\.google\.com|manus\.im|butterfly-effect\.dev)/i.test(
            host
          )
        ) {
          // [SECURITY] Fail-closed sendBeacon: provider-host beacons
          // bypass fetch/XHR hooks entirely. Analytics payloads from
          // chat UIs can embed user text (draft buffers, error
          // reports). Refuse the beacon unconditionally — the return
          // value of false signals the page that delivery failed,
          // which chat apps gracefully ignore.
          LOG("provider beacon BLOCKED:", redactUrl(url), "bodyType=" + typeof data);
          return false;
        }
        if (guardActive()) {
          const abs = new URL(url, location.href).toString();
          const sb = syncBody(data);
          const r = guardDecide(abs, sb.unreadable ? { unreadable: true } : sb.bytes ? { bytes: sb.bytes } : { text: sb.text });
          // 止めたときは「送った」と返す (解析 SDK が別経路で送り直し続けないように)
          if (r.action === "block") return true;
          if (r.action === "scrub" && !(data instanceof FormData)) {
            return originalSendBeacon(url, r.text != null ? (sb.form ? new URLSearchParams(r.text) : r.text) : r.bytes);
          }
          if (r.action === "scrub") return true;
        }
      } catch (_) {}
      return originalSendBeacon(url, data);
    };
  }

  // --- WebSocket hook ----------------------------------------------------
  //
  // manus.im uses Socket.IO v4 (Engine.IO v4) over WebSocket for chat
  // submission. Outgoing user text arrives as an EVENT frame:
  //
  //   42["message", {id, timestamp, type: "user_message", content, ...}]
  //
  // We parse each send() frame, mask the ``content`` field via the
  // shared ``manusAdapter`` (which already knows how to extract /
  // replace ``content``), and re-serialize. Non-EVENT frames
  // (ping/pong, CONNECT, ACK) and EVENT frames of other shapes pass
  // through untouched. WebSocket is not closed on user-cancel —
  // dropping the single frame is enough and keeps the session alive.

  function parseSocketIoEvent(raw) {
    if (typeof raw !== "string") return null;
    const m = raw.match(/^(42\d*)(\[[\s\S]*\])$/);
    if (!m) return null;
    let args;
    try {
      args = JSON.parse(m[2]);
    } catch (_) {
      return null;
    }
    if (!Array.isArray(args) || typeof args[0] !== "string") return null;
    return { prefix: m[1], args };
  }

  function serializeSocketIoEvent(prefix, args) {
    return prefix + JSON.stringify(args);
  }

  const manusWsAdapter = {
    name: "manus-ws",
    matchUrl(url) {
      return /^wss?:\/\/(?:[^/]*\.)?manus\.im\/socket\.io\//i.test(url || "");
    },
    // Returns ``{ bodyJson, restore }`` only for the chat-submit frame
    // the fetch-oriented ``manusAdapter`` can actually mask; null for
    // any other event so they pass through unchanged.
    handleEvent(args) {
      if (args[0] !== "message") return null;
      const payload = args[1];
      if (!payload || typeof payload !== "object") return null;
      if (payload.type !== "user_message") return null;
      const hasContent =
        typeof payload.content === "string" && payload.content.trim();
      const hasContents =
        Array.isArray(payload.contents) &&
        payload.contents.some(
          (c) =>
            c?.type === "text" &&
            typeof c.value === "string" &&
            c.value.trim()
        );
      if (!hasContent && !hasContents) return null;
      return {
        bodyJson: payload,
        restore: (maskedBody) => ["message", maskedBody, ...args.slice(2)],
      };
    },
  };

  if (typeof WebSocket !== "undefined") {
    const originalWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedWsSend(data) {
      let asyncHandled = false;
      try {
        const url = this.url || "";
        const host = new URL(url, location.href).host;
        if (
          /(claude\.(ai|com)|\.claude\.com|chatgpt\.com|\.openai\.com|gemini\.google\.com|manus\.im|butterfly-effect\.dev)/i.test(
            host
          )
        ) {
          const size = (data && typeof data.length === "number") ? data.length : 0;
          LOG(
            "provider ws send:",
            redactUrl(url),
            "bodyType=" + typeof data,
            "size=" + size,
            "preview=" + previewPayload(data)
          );
        }

        if (manusWsAdapter.matchUrl(url) && typeof data === "string") {
          const parsed = parseSocketIoEvent(data);
          if (!parsed) {
            // ping/pong/CONNECT/ACK — pass through silently.
          } else {
            const wrapped = manusWsAdapter.handleEvent(parsed.args);
            if (!wrapped) {
              // Non-chat EVENT (typing, ack, etc.) — pass through.
            } else {
              asyncHandled = true;
              const ws = this;
              const args = arguments;
              const redacted = redactUrl(url);
              LOG("manus-ws: intercepting user_message frame");
              (async () => {
                if (!(await isEnabled())) {
                  originalWsSend.apply(ws, args);
                  return;
                }
                try {
                  const result = await processBody(
                    manusAdapter,
                    wrapped.bodyJson,
                    redacted
                  );
                  if (!result.changed) {
                    originalWsSend.apply(ws, args);
                    return;
                  }
                const newFrame = serializeSocketIoEvent(
                  parsed.prefix,
                  wrapped.restore(result.body)
                );
                LOG(
                  `${manusWsAdapter.name}: substituted masked WS frame (${data.length} → ${newFrame.length} bytes)`
                );
                originalWsSend.call(ws, newFrame);
              } catch (err) {
                if (
                  err &&
                  err.message &&
                  err.message.includes("mask-mcp: user cancelled")
                ) {
                  LOG(err.message, "— WS frame dropped");
                  return;
                }
                // [SECURITY] Fail-closed: drop the frame instead of
                // forwarding the original. The WS stays open so the
                // session survives; the chat UI treats this as a
                // missing ack and typically re-prompts.
                WARN(
                  "WS hook error; DROPPING frame (fail-closed):",
                  err?.message || err
                );
              }
            })();
            }
          }
        }
      } catch (err) {
        WARN("WS send hook setup failed:", err?.message || err);
      }
      if (!asyncHandled) {
        // アダプタが扱わないフレームにも持ち出しガードを掛ける (入力中の文字を送るイベント等)
        try {
          if (guardActive()) {
            const sb = syncBody(data);
            const r = guardDecide(String(this.url || ""), sb.unreadable ? { unreadable: true } : sb.bytes ? { bytes: sb.bytes } : { text: sb.text });
            if (r.action === "block") return undefined; // フレームを落とす (接続は保つ)
            if (r.action === "scrub") return originalWsSend.call(this, r.text != null ? r.text : r.bytes);
          }
        } catch (_) { /* 判定できないときは従来どおり */ }
        return originalWsSend.apply(this, arguments);
      }
    };
  }

  LOG(
    "injected hooks installed on",
    window.location.hostname,
    "(fetch, xhr, sendBeacon, ws)"
  );
})();
