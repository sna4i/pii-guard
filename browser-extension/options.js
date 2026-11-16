// Options page — full settings UI with mask allowlist database.
// Mirrors popup.js for shared toggles and adds CRUD + import/export
// for the maskAllowlist key in chrome.storage.local.

const $ = (id) => document.getElementById(id);
const DLOG = window.PiiGuardDiagLog; // 動作ログ (docs/diagnostic-log.md)
if (DLOG) DLOG.captureErrors("options");

// --- Allowlist CRUD -----------------------------------------------------

async function loadAllowlist() {
  const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
  renderAllowlist(maskAllowlist);
}

function renderAllowlist(items) {
  const container = $("allowlist-entries");
  $("allowlist-count").textContent = items.length + "件";
  while (container.firstChild) container.removeChild(container.firstChild);
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "登録なし — 上の入力欄から追加してください";
    container.appendChild(empty);
    return;
  }
  for (const val of items) {
    const row = document.createElement("div");
    row.className = "entry";
    const text = document.createElement("span");
    text.className = "entry-value";
    text.textContent = val;
    const btn = document.createElement("button");
    btn.className = "entry-remove";
    btn.textContent = "\u00d7";
    btn.title = "削除";
    btn.addEventListener("click", () => removeFromAllowlist(val));
    row.appendChild(text);
    row.appendChild(btn);
    container.appendChild(row);
  }
}

async function addToAllowlist(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return;
  const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
  if (maskAllowlist.includes(trimmed)) return;
  maskAllowlist.push(trimmed);
  await chrome.storage.local.set({ maskAllowlist });
  renderAllowlist(maskAllowlist);
}

async function removeFromAllowlist(value) {
  const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
  const filtered = maskAllowlist.filter((v) => v !== value);
  await chrome.storage.local.set({ maskAllowlist: filtered });
  renderAllowlist(filtered);
}

async function clearAllowlist() {
  if (!confirm("すべての除外エントリを削除します。よろしいですか?")) return;
  await chrome.storage.local.set({ maskAllowlist: [] });
  renderAllowlist([]);
}

async function exportAllowlist() {
  const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
  const blob = new Blob(
    [JSON.stringify({ maskAllowlist, exported_at: new Date().toISOString() }, null, 2)],
    { type: "application/json" }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mask-allowlist-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importAllowlist(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const incoming = Array.isArray(data?.maskAllowlist)
      ? data.maskAllowlist.filter((v) => typeof v === "string")
      : [];
    if (incoming.length === 0) {
      alert("インポートできるエントリがありません");
      return;
    }
    const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
    const merged = Array.from(new Set([...maskAllowlist, ...incoming]));
    await chrome.storage.local.set({ maskAllowlist: merged });
    renderAllowlist(merged);
    alert(`${incoming.length}件をインポートしました (重複除外後 ${merged.length}件)`);
  } catch (err) {
    alert("インポート失敗: " + (err && err.message ? err.message : err));
  }
}

// --- マスキングがオンのときの背景色 (1.6.0、docs/composer-toggle.md D-26) ---------
// 色見本は tint.js の PRESETS から作る。見本の左右は、明るい表示と暗い表示で実際に
// 付く色。保存するのは "#rrggbb" か null (「なし」) だけ。

const TINT_PREVIEW_LIGHT = "#ffffff";
const TINT_PREVIEW_DARK = "#212121";

function buildTintPalette() {
  const T = window.PiiGuardTint;
  const box = $("chat-tint-palette");
  if (!T || !box) return;
  for (const it of [{ name: "なし", hex: "" }, ...T.PRESETS]) {
    const label = document.createElement("label");
    label.className = "swatch";
    label.title = it.name;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "chat-tint";
    input.value = it.hex;
    const chip = document.createElement("span");
    chip.className = it.hex ? "chip" : "chip none";
    for (const base of [TINT_PREVIEW_LIGHT, TINT_PREVIEW_DARK]) {
      const half = document.createElement("span");
      half.className = "half";
      half.style.background = it.hex ? T.tintedBackground(it.hex, base) : base;
      chip.appendChild(half);
    }
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = it.name;
    label.append(input, chip, name);
    box.appendChild(label);
  }
}

function showTint(value) {
  const preset = [...document.querySelectorAll('#chat-tint-palette input[name="chat-tint"]')]
    .find((r) => r.value === (value || ""));
  if (preset) { preset.checked = true; return; }
  $("chat-tint-custom-radio").checked = true;
  $("chat-tint-custom").value = value;
}

async function loadChatTint() {
  const T = window.PiiGuardTint;
  const { chatTint } = await chrome.storage.local.get("chatTint");
  showTint(T ? T.normalizeTint(chatTint) : null);
}

async function saveChatTint(value) {
  const T = window.PiiGuardTint;
  await chrome.storage.local.set({ chatTint: T ? T.normalizeTint(value) : null });
}

// --- Settings (mirrors popup) ------------------------------------------

async function loadEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  $("opt-enabled").checked = enabled;
}

async function loadInteractive() {
  const { interactive = true } = await chrome.storage.local.get("interactive");
  $("opt-interactive").checked = interactive;
}

async function loadUiMode() {
  const { uiMode } = await chrome.storage.local.get("uiMode");
  const value = uiMode === "modal" ? "modal" : "sidebar";
  const target = document.querySelector(`input[name="ui-mode"][value="${value}"]`);
  if (target) target.checked = true;
}

// The Chrome Web Store variant strips this entire block so nothing
// in the Store bundle references http://localhost:11434, `ollama`
// tags, or LLM_FETCH messages. The corresponding UI card in
// options.html is stripped separately (line ~71-130 there).

// --- Local LLM section -------------------------------------------------

function setLlmStatus(state, text) {
  const el = $("llm-status");
  el.textContent = text;
  el.className = "status-pill status-" + state;
}

// Mirror of setLlmStatus for the ML toggle. Reuses the same .status-X
// CSS classes (status-ok / status-checking / status-err / status-unknown)
// so the visual language stays consistent across cards.
function setMlStatus(state, text) {
  const el = $("ml-status");
  if (!el) return;
  el.textContent = text;
  el.className = "status-pill status-" + state;
}

// Three Hugging Face Hub origins the bundled NER model fetches its
// weights from. Listed in the manifest as `optional_host_permissions`
// for the Store build (request at runtime via chrome.permissions.request).
// The dev manifest lists them under regular `host_permissions` so the
// integration test never needs to click through the prompt.
const ML_HF_ORIGINS = [
  "https://huggingface.co/*",
  "https://cdn-lfs.huggingface.co/*",
  "https://cdn-lfs-us-1.hf.co/*",
];

async function requestMlHostPermission() {
  if (!chrome.permissions || typeof chrome.permissions.request !== "function") {
    return true;
  }
  try {
    if (await chrome.permissions.contains({ origins: ML_HF_ORIGINS })) return true;
  } catch (_) { /* fall through to request */ }
  try {
    return await chrome.permissions.request({ origins: ML_HF_ORIGINS });
  } catch (e) {
    if (window.PiiGuardDiagLog) PiiGuardDiagLog.log("error", PiiGuardDiagLog.errorFields(e, "options"));
    return false;
  }
}

// Fire ML_PREWARM and update status as the response (or error) lands.
// Caller is expected to have already flipped mlEnabled=true and the
// status pill to "モデル DL 中…".
function prewarmMl() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "ML_PREWARM" }, (resp) => {
        if (chrome.runtime.lastError) {
          setMlStatus("err", "通信エラー: " + chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        if (resp && resp.ok === true) {
          setMlStatus("ok", "✓ 準備完了");
          resolve(true);
          return;
        }
        const err = (resp && resp.error) || "不明なエラー";
        setMlStatus("err", "失敗: " + err);
        resolve(false);
      });
    } catch (e) {
      setMlStatus("err", "送信エラー: " + (e?.message || e));
      resolve(false);
    }
  });
}

function normalizeUrl(raw) {
  if (!raw) return "";
  let url = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  return url;
}

// Build a chrome.permissions origin pattern from a user-entered URL.
// chrome.permissions accepts full match patterns like "http://host:port/*"
// or "https://host/*" — it rejects bare origins, trailing-slash-free
// forms, and non-http(s) schemes. Returns null if the URL cannot be
// turned into a valid pattern.
function toOriginPattern(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return null;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.host) return null;
  // Form: "<scheme>://<host>[:port]/*" — origin already excludes path.
  return parsed.origin + "/*";
}

// Request (or confirm) host permission for the user-provided LLM URL.
// MUST be called synchronously from a user gesture handler (click /
// keyup / change) — otherwise Chrome rejects the request with
// "This function must be called during a user gesture."
//
// Resolution order:
//   1. If `chrome.permissions` is unavailable (unexpected extension
//      context), log a warning and return true so callers fall back
//      to attempting the fetch directly. This keeps dev builds with
//      `host_permissions: ["http://*/*"]` working even in edge cases.
//   2. If the origin is already granted (dev build, or user has
//      already approved), `chrome.permissions.contains()` returns
//      true — we short-circuit without prompting.
//   3. Otherwise call `chrome.permissions.request()` which shows the
//      Chrome permission dialog. Returns the user's decision.
async function ensureLlmHostPermission(rawUrl) {
  const pattern = toOriginPattern(rawUrl);
  if (!pattern) return false;
  if (!chrome || !chrome.permissions || typeof chrome.permissions.request !== "function") {
    return true;
  }
  try {
    const already = await chrome.permissions.contains({ origins: [pattern] });
    if (already) return true;
  } catch (err) {
    // Fall through and try request() — contains() failure shouldn't block.
  }
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    return granted === true;
  } catch (err) {
    if (window.PiiGuardDiagLog) PiiGuardDiagLog.log("error", PiiGuardDiagLog.errorFields(err, "options"));
    return false;
  }
}

async function swFetch(url, timeoutMs) {
  // Route through the service worker so Chrome's Private Network Access
  // policy does not block HTTPS-page → http://localhost calls.
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "LLM_FETCH",
      url,
      method: "GET",
      timeoutMs: timeoutMs || 4000,
    });
    return resp || null;
  } catch (_) {
    return null;
  }
}

async function probeLlm(url) {
  if (!url) return { ok: false, reason: "no-url" };
  const tagsResp = await swFetch(url + "/api/tags", 4000);
  if (tagsResp && tagsResp.ok && tagsResp.body) {
    try {
      const tags = JSON.parse(tagsResp.body);
      if (Array.isArray(tags.models)) {
        return { ok: true, kind: "ollama", models: tags.models.map((m) => m.name) };
      }
    } catch (_) {}
  }
  if (tagsResp && tagsResp.status === 403) {
    return { ok: false, reason: "cors", status: 403 };
  }
  const oaiResp = await swFetch(url + "/v1/models", 4000);
  if (oaiResp && oaiResp.ok && oaiResp.body) {
    try {
      const oai = JSON.parse(oaiResp.body);
      if (Array.isArray(oai.data)) {
        return { ok: true, kind: "openai-compat", models: oai.data.map((m) => m.id) };
      }
    } catch (_) {}
  }
  return { ok: false, reason: "unreachable", status: tagsResp && tagsResp.status };
}

async function testLlm() {
  const rawUrl = $("llm-url").value;
  const url = normalizeUrl(rawUrl);
  if (!url) {
    setLlmStatus("unknown", "URL 未設定");
    return;
  }
  // Gate fetch behind host permission. In the Store variant no LLM
  // host is granted at install time, so we request it from this
  // click-handler user gesture. In dev builds where http://*/* is
  // already in host_permissions, `contains()` returns true and no
  // dialog is shown.
  const granted = await ensureLlmHostPermission(url);
  if (!granted) {
    setLlmStatus("err", "ホスト権限が拒否されました (" + url + ")");
    return;
  }
  setLlmStatus("checking", "接続確認中...");
  const result = await probeLlm(url);
  if (result && result.ok) {
    setLlmStatus("ok", `接続 OK (${result.kind}, ${result.models.length} モデル)`);
    populateModels(result.models);
    await chrome.storage.local.set({ localLlmUrl: url, localLlmKind: result.kind });
  } else if (result && result.reason === "cors") {
    setLlmStatus("err", "CORS 拒否 — OLLAMA_ORIGINS 設定が必要");
    alert(
      "Ollama サーバーが 403 を返しました。CORS 設定が原因です。\n\n" +
        "解決方法 (いずれか):\n\n" +
        "  1. ollama バイナリで起動:\n" +
        "     OLLAMA_ORIGINS='*' ollama serve\n\n" +
        "  2. Docker で起動中:\n" +
        "     docker stop ollama && \\\n" +
        "     docker run -d --name ollama -e OLLAMA_ORIGINS='*' \\\n" +
        "       -p 11434:11434 -v ollama:/root/.ollama ollama/ollama\n\n" +
        "  3. systemd で起動中:\n" +
        "     sudo systemctl edit ollama\n" +
        "     → [Service] Environment=\"OLLAMA_ORIGINS=*\"\n" +
        "     sudo systemctl restart ollama\n\n" +
        "設定後にこの画面をリロードして再度「接続確認」を押してください。"
    );
  } else {
    setLlmStatus(
      "err",
      `接続失敗 (${(result && result.status) || "no-response"})`
    );
  }
}

function populateModels(models) {
  const sel = $("llm-model");
  const prev = sel.value;
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "(未選択)";
  sel.appendChild(blank);
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    if (m === prev) opt.selected = true;
    sel.appendChild(opt);
  }
  renderRecommendList(models);
}

// Curated list of models that handle Japanese + JSON-constrained
// detection reasonably well. The "accuracy" column is a qualitative
// label from in-house PII benchmarks, NOT an academic score — it
// reflects relative behaviour on 100 mixed JA/EN test prompts.
// ``size`` is approximate on-disk / download size for the default
// Ollama quantization (Q4_K_M). ``vram`` is peak runtime VRAM with
// the default 4k-8k context. Both values come from Ollama's public
// model cards and in-house measurements.
const RECOMMENDED_MODELS = [
  {
    name: "qwen3:1.7b",
    size: "1.1 GB",
    vram: "~1.5 GB",
    desc: "軽量 · 日本語対応 · 最初の選択肢",
    badge: { label: "軽量", cls: "b-light" },
  },
  {
    name: "qwen3:4b",
    size: "2.5 GB",
    vram: "~3 GB",
    desc: "推奨 · バランス型 · 精度/速度のバランス◎",
    badge: { label: "推奨", cls: "b-recommend" },
  },
  {
    name: "qwen3:8b",
    size: "4.7 GB",
    vram: "~5 GB",
    desc: "高精度 · 文脈検出が正確",
    badge: { label: "高精度", cls: "b-high" },
  },
  {
    name: "qwen3:14b",
    size: "8.2 GB",
    vram: "~9 GB",
    desc: "最高精度 · 複雑な日本語ビジネス文書向け",
    badge: { label: "最高精度", cls: "b-top" },
  },
  {
    name: "gemma3:4b",
    size: "2.5 GB",
    vram: "~3 GB",
    desc: "代替 · Google · Qwen3 系の代替候補",
    badge: { label: "代替", cls: "b-alt" },
  },
  {
    name: "llama3.2:3b",
    size: "2.0 GB",
    vram: "~2 GB",
    desc: "代替 · 英語寄り",
    badge: { label: "代替", cls: "b-alt" },
  },
  {
    name: "phi3.5:3.8b",
    size: "2.2 GB",
    vram: "~2.5 GB",
    desc: "代替 · Microsoft",
    badge: { label: "代替", cls: "b-alt" },
  },
];

function renderRecommendList(installedModels) {
  const container = $("llm-recommend-list");
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  const installedSet = new Set(installedModels || []);
  // Tags in Ollama include ":latest" suffix for default tags; normalise
  // "qwen3:1.7b" vs "qwen3:1.7b-instruct" etc.
  const isInstalled = (name) =>
    installedSet.has(name) ||
    [...installedSet].some((m) => m === name || m.startsWith(name + ":"));

  for (const rec of RECOMMENDED_MODELS) {
    const row = document.createElement("div");
    row.className = "llm-recommend-item";
    row.dataset.model = rec.name;

    const name = document.createElement("div");
    name.className = "llm-recommend-name";
    name.textContent = rec.name;

    const size = document.createElement("span");
    size.className = "llm-recommend-size";
    size.title = "ダウンロードサイズ · VRAM 使用量 (推定)";
    size.textContent = `${rec.size} / VRAM ${rec.vram}`;

    const desc = document.createElement("div");
    desc.className = "llm-recommend-desc";
    desc.textContent = rec.desc;

    const badge = document.createElement("span");
    badge.className = "llm-recommend-badge " + rec.badge.cls;
    badge.textContent = rec.badge.label;

    const action = document.createElement("div");
    action.className = "llm-recommend-action";
    if (isInstalled(rec.name)) {
      const tag = document.createElement("span");
      tag.className = "llm-recommend-installed";
      tag.textContent = "✓ インストール済";
      action.appendChild(tag);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-delete";
      delBtn.textContent = "削除";
      delBtn.title = `${rec.name} を Ollama から削除`;
      delBtn.addEventListener("click", () => deleteModel(rec.name, row));
      action.appendChild(delBtn);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-pull";
      btn.textContent = "ダウンロード";
      btn.addEventListener("click", () => pullModel(rec.name, row));
      action.appendChild(btn);
    }

    row.appendChild(name);
    row.appendChild(size);
    row.appendChild(desc);
    row.appendChild(badge);
    row.appendChild(action);
    container.appendChild(row);
  }
}

// Delete an installed model from Ollama via DELETE /api/delete.
// Fires after an explicit confirm() — there's no undo (the model
// files are removed from disk) so the guard is deliberate.
async function deleteModel(modelName, rowEl) {
  const baseUrl = normalizeUrl($("llm-url").value);
  if (!baseUrl) {
    alert("先に URL を設定してください");
    return;
  }
  // Called from a button click, so we're inside a user gesture and
  // can request host permission if the Store variant hasn't granted
  // it yet. Do the permission check BEFORE confirm() so we don't
  // ask the user to confirm an action we know will fail.
  const granted = await ensureLlmHostPermission(baseUrl);
  if (!granted) {
    alert("Ollama サーバーへのアクセス権限が拒否されました: " + baseUrl);
    return;
  }
  if (!confirm(`${modelName} を Ollama から削除します。\n\nこの操作は元に戻せません (モデルファイルが実際に削除されます)。続行しますか?`)) {
    return;
  }
  const actionEl = rowEl.querySelector(".llm-recommend-action");
  while (actionEl.firstChild) actionEl.removeChild(actionEl.firstChild);
  const progress = document.createElement("span");
  progress.className = "llm-recommend-progress";
  progress.textContent = "削除中…";
  actionEl.appendChild(progress);

  try {
    const resp = await fetch(baseUrl + "/api/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });
    if (!resp.ok) {
      throw new Error(`${resp.status} ${resp.statusText}`);
    }
    progress.textContent = "✓ 削除しました";
    progress.style.color = "var(--ok)";
    // If the user was using this model, clear the stored selection.
    try {
      const stored = await chrome.storage.local.get("localLlmModel");
      if (stored.localLlmModel === modelName) {
        await chrome.storage.local.set({ localLlmModel: "" });
      }
    } catch (_) {}
    setTimeout(() => testLlm(), 600);
  } catch (err) {
    progress.textContent = "失敗: " + (err?.message || err);
    progress.style.color = "var(--err)";
    setTimeout(() => {
      const currentModels = [...($("llm-model").options || [])].map((o) => o.value);
      renderRecommendList(currentModels);
    }, 3000);
  }
}

// Pull a model from Ollama via streaming NDJSON, so the UI can
// display real-time progress (percentage + size). The options page
// runs in a chrome-extension:// context — unlike content scripts
// on HTTPS sites, it's NOT subject to Private Network Access, so
// we can fetch http://localhost:11434 directly without going
// through the service worker proxy.
async function pullModel(modelName, rowEl) {
  const baseUrl = normalizeUrl($("llm-url").value);
  if (!baseUrl) {
    alert("先に URL を設定してください");
    return;
  }
  // Same user-gesture permission gate as deleteModel. Runs before
  // we show any progress UI so we don't briefly flash a spinner
  // and then hit a fetch error.
  const granted = await ensureLlmHostPermission(baseUrl);
  if (!granted) {
    alert("Ollama サーバーへのアクセス権限が拒否されました: " + baseUrl);
    return;
  }
  const actionEl = rowEl.querySelector(".llm-recommend-action");
  while (actionEl.firstChild) actionEl.removeChild(actionEl.firstChild);

  const progressWrap = document.createElement("div");
  progressWrap.className = "llm-recommend-progress-wrap";
  const progressBar = document.createElement("div");
  progressBar.className = "llm-recommend-progress-bar";
  const progressFill = document.createElement("div");
  progressFill.className = "llm-recommend-progress-fill";
  progressBar.appendChild(progressFill);
  const progressText = document.createElement("span");
  progressText.className = "llm-recommend-progress";
  progressText.textContent = "開始中…";
  progressWrap.appendChild(progressBar);
  progressWrap.appendChild(progressText);
  actionEl.appendChild(progressWrap);

  const humanBytes = (n) => {
    if (!Number.isFinite(n)) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
    return n + " B";
  };

  try {
    const resp = await fetch(baseUrl + "/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: true }),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`${resp.status} ${resp.statusText}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let success = false;
    // Track overall progress by keeping the largest total/completed
    // we've seen — Ollama emits progress per-layer, so the latest
    // event is the most informative.
    let lastTotal = 0;
    let lastCompleted = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (ev.error) {
          throw new Error(ev.error);
        }
        const status = String(ev.status || "");
        const total = Number(ev.total) || 0;
        const completed = Number(ev.completed) || 0;
        if (total > lastTotal) lastTotal = total;
        if (completed > lastCompleted) lastCompleted = completed;
        if (status === "success") {
          success = true;
          progressFill.style.width = "100%";
          progressText.textContent = "✓ ダウンロード完了";
          progressText.style.color = "var(--ok)";
          break;
        }
        if (total > 0 && completed > 0) {
          const pct = Math.min(100, Math.round((completed / total) * 100));
          progressFill.style.width = pct + "%";
          progressText.textContent = `${pct}% (${humanBytes(completed)} / ${humanBytes(total)})`;
        } else {
          // Meta phases: "pulling manifest" / "verifying" / "writing
          // manifest" / "removing any unused layers".
          progressText.textContent = status || "ダウンロード中…";
        }
      }
      if (success) break;
    }
    if (!success) {
      throw new Error("unexpected end of stream");
    }
    // Refresh tags → updates dropdown + flips this row to
    // "✓ インストール済".
    setTimeout(() => testLlm(), 600);
  } catch (err) {
    progressFill.style.background = "var(--err)";
    progressText.textContent = "失敗: " + (err?.message || err);
    progressText.style.color = "var(--err)";
    // Re-render the row after 4s so the ダウンロード button comes back.
    setTimeout(() => {
      const currentModels = [...($("llm-model").options || [])].map((o) => o.value);
      renderRecommendList(currentModels);
    }, 4000);
  }
}

// Read mlEnabled from storage and refresh the ML toggle + status pill.
// If ML is already enabled (returning user), kick off a silent prewarm
// so the status flips to "✓ 準備完了" once the cached model is loaded
// — saves the user from having to click anything to confirm health.
async function loadMlSettings() {
  const toggle = $("ml-enabled");
  if (!toggle) return;
  const stored = await chrome.storage.local.get("mlEnabled");
  const enabled = stored.mlEnabled === true;
  toggle.checked = enabled;
  if (!enabled) {
    setMlStatus("unknown", "未有効");
    return;
  }
  // Already enabled — confirm permission still granted, then prewarm.
  const granted =
    chrome.permissions && chrome.permissions.contains
      ? await chrome.permissions.contains({ origins: ML_HF_ORIGINS }).catch(() => false)
      : true;
  if (!granted) {
    // Permission was revoked from chrome://extensions. Reset the flag
    // so detect calls don't fire against an SW that can't reach HF.
    await chrome.storage.local.set({ mlEnabled: false });
    toggle.checked = false;
    setMlStatus("err", "ホスト権限が外れています — もう一度有効化してください");
    return;
  }
  setMlStatus("checking", "モデル準備中…");
  prewarmMl();
}

async function loadLlmSettings() {
  const stored = await chrome.storage.local.get([
    "localLlmEnabled",
    "localLlmUrl",
    "localLlmModel",
    "localLlmMode",
    "localLlmTimeoutMs",
  ]);
  $("llm-enabled").checked = stored.localLlmEnabled === true;
  $("llm-url").value = stored.localLlmUrl || "";
  $("llm-mode").value = stored.localLlmMode === "replace" ? "replace" : "detect";
  $("llm-timeout").value = stored.localLlmTimeoutMs || 120000;
  if (stored.localLlmModel) {
    const opt = document.createElement("option");
    opt.value = stored.localLlmModel;
    opt.textContent = stored.localLlmModel + " (保存済み)";
    opt.selected = true;
    $("llm-model").appendChild(opt);
  }
  if (stored.localLlmUrl && stored.localLlmEnabled) {
    testLlm();
  } else if (!stored.localLlmUrl) {
    setLlmStatus("unknown", "未設定");
  } else {
    setLlmStatus("unknown", "無効化中");
  }
}


// ---- Pro 版 (docs/pro-license.md の F-PRO-07、D-PRO-05) ------------------------------
// 状態は Service Worker のライセンス管理に聞く。支払いの直後は自動では届かないので (extensionpay.com に
// content script を置いていない)、「購入状態を更新」で確かめ直す
function renderProLicense(state) {
  const v = window.PiiGuardLicenseView.describeLicense(state);
  crApplyLicense(v.visible, !!state && state.pro === true); // カスタムルールのカードも、同じ答えで出し分ける
  $("pro-card").hidden = !v.visible;
  if (!v.visible) return;
  const st = $("pro-status");
  st.textContent = v.status;
  st.dataset.tone = v.tone;
  $("pro-note").textContent = v.note;
  $("pro-note").hidden = !v.note;
  $("pro-upgrade").hidden = !v.canUpgrade;
  $("pro-login").hidden = !v.canLogin;
  $("pro-refresh").hidden = !v.canRefresh;
}
async function loadProLicense(refresh) {
  let state = null;
  try { state = await chrome.runtime.sendMessage({ type: "license:get", refresh: refresh === true }); } catch (_) {}
  renderProLicense(state);
  // キャッシュで先に出したとき (60 分を過ぎている) は、確かめ直しの答えを待って出し直す。確かめられなければ注記が出る。
  // 裏の確かめ直しが走っていればそれを待ち、もう終わっていれば、もう 1 回問い合わせる (D-PRO-11)
  if (refresh !== true && state && state.source === "stale") loadProLicense(true);
}
async function openProPage(type) {
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type }); } catch (_) {}
  if (!(r && r.ok)) {
    $("pro-note").textContent = window.PiiGuardLicenseView.describeOpenFailure(r && r.reason);
    $("pro-note").hidden = false;
  }
}

// ---- Pro のカスタムルール (Pro Phase 2 の設計 (P1)、T-CR-41〜50) --------------------------------
// ルールを足す・直す・消す・書き出す・読み込むのは、ここだけ。Pro かどうかは #pro-card と同じ license:get の答え
// (renderProLicense が crApplyLicense に渡す)。ID が仮の版ではカードごと出さず、Worker も立てない。
//
// 保存と読み込みの確かめ (validateRule・stressTest・importRules) は、この画面のスレッドでは走らせない。
// 正規表現の 1 回の照合は途中で止められず、時間を食う形が通り抜けると、試したとたんに設定画面ごと固まるため。
// options-rules-worker.js (Worker) に 1 本ずつ頼み、CR_CHECK_MS たっても答えが来なければ、Worker を止めて作り直し、
// そのルールだけを「時間がかかりすぎる正規表現です」で断る。ここで使う engine/custom-rules.js の部品は、定数
// (LIMITS・STORAGE_KEY) と exportRules (JSON にするだけで、正規表現は動かさない) だけ。
// 一覧・エラー・結果は textContent だけで組む (利用者の文字を innerHTML に入れない)。
const CR = (window.__localMaskMCP && window.__localMaskMCP.engine && window.__localMaskMCP.engine.customRules) || null;
const CR_CHECK_MS = 1000; // ルール 1 本の確かめを待つ時間 (読み込み全体ではなく、1 本ごと)
const CR_TIMEOUT_REASON = "時間がかかりすぎる正規表現です";
const CR_UNAVAILABLE = "確かめる処理を始められませんでした。設定画面を開き直してください";
const CR_EXPORT_FILE = "pii-guard-custom-rules.json";
// ハイフン類で断られたときに足す、書き直しの例 (どれも validateRule を通る)
const CR_HYPHEN_EXAMPLES = ["[ァ-ヶー-]", "[ァ-ヶ][ァ-ヶー]*", "[ー-]"];
// 完全一致の文字の種類のうち「ひらがな」。ー はカタカナの仲間なので、ここには入らない
const CR_HIRAGANA = /^\p{Script=Hiragana}$/u;

let crPro = false; // 今 Pro か。false のあいだは、カードの操作を全部止める
let crBusy = false; // 保存・読み込み・一覧の操作の最中。重ねて操作させない
let crEditing = null; // 編集中のルール { index, snapshot } か null
let crListShown = false; // 一覧を出したか (カードが見えるようになったとき 1 回だけ読む。そのあとは storage の変化で出し直す)
let crRenderSeq = 0; // 一覧を出し直すたびに増やす (古い確かめの答えで、新しい一覧を汚さない)

// Worker に 1 つ頼んで、答え・時間切れ ({ timedOut: true })・Worker を使えないこと ({ failed: true }) のどれかを返す。
// 時間切れのときは、その Worker を止める (次の頼みで、新しい Worker を立てる)
function crWorker() {
  let worker = null;
  let nextId = 0;
  const stop = () => { if (worker) { worker.terminate(); worker = null; } };
  function ask(request, ms = CR_CHECK_MS) {
    return new Promise((resolve) => {
      if (!worker) {
        try { worker = new Worker("options-rules-worker.js"); } catch (_) { resolve({ failed: true }); return; }
      }
      const mine = worker;
      const id = ++nextId;
      let timer = null;
      const finish = (answer) => {
        clearTimeout(timer);
        mine.removeEventListener("message", onMessage);
        mine.removeEventListener("error", onError);
        resolve(answer);
      };
      const onMessage = (e) => { if (e.data && e.data.id === id) finish(e.data); };
      const onError = () => { if (worker === mine) stop(); finish({ failed: true }); };
      timer = setTimeout(() => { if (worker === mine) stop(); finish({ timedOut: true }); }, ms);
      mine.addEventListener("message", onMessage);
      mine.addEventListener("error", onError);
      mine.postMessage({ id, ...request });
    });
  }
  return { ask, stop };
}
// ok でない答え (断られた・時間切れ・Worker が使えない) から、画面に出す理由の行を作る
const crReasons = (answer, timedOutText) => (answer.timedOut ? [timedOutText] : answer.failed ? [CR_UNAVAILABLE] : answer.errors);

async function crReadRules() {
  const stored = (await chrome.storage.local.get(CR.STORAGE_KEY))[CR.STORAGE_KEY];
  return stored && Array.isArray(stored.rules) ? stored.rules.slice() : [];
}
const crWriteRules = (rules) => chrome.storage.local.set({ [CR.STORAGE_KEY]: { version: 1, rules } });
const crFullMessage = () => `ルールは ${CR.LIMITS.maxRules} 個までです。これ以上は足せません (不要なルールを削除してください)`;

// 保存できない理由を、1 つずつ行に分けて出す。空の配列なら消す
function crShowErrors(lines) {
  const box = $("cr-errors");
  box.textContent = "";
  for (const text of lines) {
    const line = document.createElement("p");
    line.textContent = text;
    box.appendChild(line);
  }
  // 見た目にハイフンの無い [ァ-ヶー]+ や \p{L}+ も、この理由で断られる。書き直しの例を 1 行足す
  if (lines.some((t) => t.includes("ハイフン類"))) {
    const hint = document.createElement("p");
    hint.className = "cr-error-hint";
    hint.append("ハイフンが見当たらなくても、ー (長音) を含む文字の並び ([ァ-ヶー]+ や \\p{L}+ など) は、この理由で断られることがあります。書き直しの例: ");
    CR_HYPHEN_EXAMPLES.forEach((example, i) => {
      if (i > 0) hint.append("、");
      const code = document.createElement("code");
      code.textContent = example;
      hint.append(code);
    });
    box.appendChild(hint);
  }
}

// 読み込みの結果。summary は「追加 N 件、…」の 1 行 (ファイル全体が読めないときは無し)、reasons は理由 (1 行ずつ)
function crShowImport(summary, reasons) {
  const box = $("cr-import-result");
  box.textContent = "";
  for (const text of summary ? [summary, ...reasons] : reasons) {
    const line = document.createElement("p");
    line.textContent = text;
    box.appendChild(line);
  }
}

// ---- フォーム ----
function crSyncKind() {
  const regex = $("cr-kind").value === "regex";
  $("cr-regex-fields").hidden = !regex;
  $("cr-words-fields").hidden = regex;
  crUpdateAdvice();
}
// 完全一致で、語の端 (先頭か終わり) がひらがなの語があれば、部分一致を勧める一言を出す。保存は止めない
function crUpdateAdvice() {
  const advice = $("cr-advice");
  const words = $("cr-kind").value === "words" && $("cr-match").value === "exact"
    ? $("cr-words").value.split(/\r\n|\r|\n/).map((w) => w.trim()).filter((w) => {
      const chars = Array.from(w);
      return chars.length > 0 && (CR_HIRAGANA.test(chars[0]) || CR_HIRAGANA.test(chars[chars.length - 1]));
    })
    : [];
  advice.hidden = words.length === 0;
  advice.textContent = words.length === 0 ? ""
    : `語の端がひらがなです (${words.slice(0, 3).map((w) => `「${w}」`).join("")}${words.length > 3 ? " ほか" : ""})。完全一致は、隣もひらがななら当たらないため、この語は部分一致の方が向いています`;
}
function crFormRule() {
  const kind = $("cr-kind").value;
  const rule = { kind, label: $("cr-label").value.trim() };
  if (kind === "regex") {
    rule.pattern = $("cr-pattern").value;
    rule.ignoreCase = $("cr-ignore-case").checked;
  } else {
    rule.words = $("cr-words").value.split(/\r\n|\r|\n/);
    rule.match = $("cr-match").value;
  }
  if (crEditing) { // 直すときは、id と有効の状態を引き継ぐ
    const before = JSON.parse(crEditing.snapshot);
    if (typeof before.id === "string" && before.id !== "") rule.id = before.id;
    if (typeof before.enabled === "boolean") rule.enabled = before.enabled;
  }
  return rule;
}
function crResetForm() {
  crEditing = null;
  for (const id of ["cr-label", "cr-pattern", "cr-words"]) $(id).value = "";
  $("cr-ignore-case").checked = false;
  $("cr-form-title").textContent = "ルールを追加";
  $("cr-cancel").hidden = true;
  crUpdateAdvice();
}
function crStartEdit(rule, index, snapshot) {
  crEditing = { index, snapshot };
  $("cr-kind").value = rule.kind === "regex" ? "regex" : "words";
  $("cr-label").value = typeof rule.label === "string" ? rule.label : "";
  $("cr-pattern").value = typeof rule.pattern === "string" ? rule.pattern : "";
  $("cr-ignore-case").checked = rule.ignoreCase === true;
  $("cr-words").value = Array.isArray(rule.words) ? rule.words.filter((w) => typeof w === "string").join("\n") : "";
  $("cr-match").value = rule.match === "partial" ? "partial" : "exact";
  $("cr-form-title").textContent = `ルール「${crLabelOf(rule)}」を編集`;
  $("cr-cancel").hidden = false;
  $("cr-status").textContent = "";
  crShowErrors([]);
  crSyncKind();
  $("cr-label").focus();
}

// ---- 一覧 ----
function crLabelOf(rule) {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return "(ルールの形ではありません)";
  return typeof rule.label === "string" && rule.label !== "" ? rule.label : "CUSTOM";
}
function crButton(className, text, ariaLabel) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.setAttribute("aria-label", ariaLabel);
  return button;
}
// 一覧の 1 行。操作は、保存済みの一覧を読み直して、この行が見せたときのまま (snapshot) のときだけ当てる (crChangeRule)
function crItem(rule, index) {
  const isRule = rule !== null && typeof rule === "object" && !Array.isArray(rule);
  const name = crLabelOf(rule);
  const snapshot = JSON.stringify(rule);
  const item = document.createElement("div");
  item.className = "cr-item";

  const main = document.createElement("div");
  main.className = "cr-item-main";
  const nameEl = document.createElement("span");
  nameEl.className = "cr-item-name";
  nameEl.textContent = name;
  const kind = document.createElement("span");
  kind.className = "cr-item-kind";
  const body = document.createElement("span");
  body.className = "cr-item-body";
  if (isRule && rule.kind === "words") {
    kind.textContent = `単語リスト (${rule.match === "partial" ? "部分一致" : "完全一致"})`;
    body.textContent = `${Array.isArray(rule.words) ? rule.words.length : 0} 語`;
  } else if (isRule && rule.kind === "regex") {
    kind.textContent = rule.ignoreCase === true ? "正規表現 (大文字と小文字を区別しない)" : "正規表現";
    const code = document.createElement("code");
    code.textContent = typeof rule.pattern === "string" ? rule.pattern : "";
    body.appendChild(code);
  } else {
    kind.textContent = "種類が分かりません";
  }
  main.append(nameEl, kind, body);
  item.appendChild(main);

  if (isRule) {
    const toggle = document.createElement("label");
    toggle.className = "switch";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = rule.enabled !== false;
    box.setAttribute("aria-label", `${name} を有効にする`);
    const slider = document.createElement("span");
    slider.className = "slider";
    toggle.append(box, slider);
    box.addEventListener("change", () => crRun(() => crChangeRule(index, snapshot, (rules) => { rules[index] = { ...rules[index], enabled: box.checked }; })));
    const edit = crButton("btn-secondary cr-edit", "編集", `${name} を編集`);
    edit.addEventListener("click", () => crStartEdit(rule, index, snapshot));
    item.append(toggle, edit);
  }
  const del = crButton("btn-danger cr-delete", "削除", `${name} を削除`);
  del.addEventListener("click", () => {
    if (!confirm(`ルール「${name}」を削除します。よろしいですか?`)) return;
    crRun(() => crChangeRule(index, snapshot, (rules) => { rules.splice(index, 1); }));
  });
  item.appendChild(del);
  return item;
}
function crDrawList(rules) {
  $("cr-count").textContent = `${rules.length} / ${CR.LIMITS.maxRules} 件`;
  const box = $("cr-list");
  box.textContent = "";
  if (rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "登録なし — 下のフォームから追加してください";
    box.appendChild(empty);
  }
  rules.forEach((rule, index) => box.appendChild(crItem(rule, index)));
  // 編集中のルールは、ほかの行を消して位置が動いたら追いかける。ほかの画面で変わった・消えたなら、編集をやめる
  if (crEditing) {
    const at = rules.findIndex((rule) => JSON.stringify(rule) === crEditing.snapshot);
    if (at >= 0) {
      crEditing.index = at;
    } else {
      crResetForm();
      $("cr-status").textContent = "編集していたルールが、ほかの画面で変わったため、編集をやめました";
    }
  }
  crSyncControls();
}
// 効いていない保存済みのルールに印と理由を付ける (エンジンは、正しくない保存済みのルールを黙って捨てるため)
function crMarkUnused(index, reasons) {
  const item = $("cr-list").children[index];
  if (!item) return;
  const note = document.createElement("p");
  note.className = "cr-unused";
  note.textContent = `このルールは使われていません: ${reasons.join(" / ")}`;
  item.appendChild(note);
}
// 一覧を先に出し、保存済みのルールを 1 本ずつ Worker で確かめて、通らないものに印を付ける
async function crRenderList() {
  const seq = ++crRenderSeq;
  const rules = await crReadRules();
  if (seq !== crRenderSeq) return;
  crDrawList(rules);
  const worker = crWorker();
  try {
    for (let i = 0; i < rules.length; i++) {
      const answer = await worker.ask({ op: "validate", rule: rules[i] });
      if (seq !== crRenderSeq || answer.failed) return;
      if (!answer.ok) crMarkUnused(i, crReasons(answer, CR_TIMEOUT_REASON));
    }
  } finally { worker.stop(); }
}

// ---- 操作 ----
// カードの操作は、Pro のときだけ、最中でないときだけ押せる
function crSyncControls() {
  const off = !crPro || crBusy;
  for (const el of $("custom-rules-card").querySelectorAll("input, select, textarea, button")) el.disabled = off;
}
// 保存・読み込み・一覧の操作は、1 つずつ走らせる (最中は、カードの操作を止める)
async function crRun(job) {
  if (crBusy) return;
  const focused = document.activeElement;
  crBusy = true;
  crSyncControls();
  try {
    await job();
  } catch (e) {
    crShowErrors(["処理に失敗しました: " + (e && e.message ? e.message : String(e))]);
    if (crListShown) crRenderList();
  } finally {
    crBusy = false;
    crSyncControls();
    if (focused && focused.isConnected && !focused.disabled) focused.focus();
  }
}
// 一覧の 1 行を変える。保存済みの一覧を読み直し、その行が見せたときのままでなければ (ほかの画面で変わった) 何もしない
async function crChangeRule(index, snapshot, change) {
  const rules = await crReadRules();
  if (JSON.stringify(rules[index]) !== snapshot) {
    crShowErrors(["ほかの画面でルールが変わっていたため、操作しませんでした。一覧を更新したので、もう一度操作してください"]);
    crRenderList();
    return false;
  }
  change(rules);
  await crWriteRules(rules);
  return true;
}
async function crAppendRule(rule) {
  const rules = await crReadRules();
  if (rules.length >= CR.LIMITS.maxRules) {
    crShowErrors([crFullMessage()]);
    return false;
  }
  rules.push(rule);
  await crWriteRules(rules);
  return true;
}
// 保存: 数の上限 → Worker で validateRule → compileRule → stressTest (50 ミリ秒) → 通れば proCustomRules に書く
async function crSave() {
  const status = $("cr-status");
  status.textContent = "";
  crShowErrors([]);
  if (!crEditing && (await crReadRules()).length >= CR.LIMITS.maxRules) {
    crShowErrors([crFullMessage()]);
    return;
  }
  status.textContent = "確認しています…";
  const worker = crWorker();
  let answer;
  try { answer = await worker.ask({ op: "check", rule: crFormRule() }); } finally { worker.stop(); }
  status.textContent = "";
  if (!answer.ok) {
    crShowErrors(crReasons(answer, CR_TIMEOUT_REASON));
    return;
  }
  const editing = crEditing;
  const saved = editing
    ? await crChangeRule(editing.index, editing.snapshot, (rules) => { rules[editing.index] = answer.rule; })
    : await crAppendRule(answer.rule);
  if (!saved) return;
  crResetForm();
  status.textContent = "保存しました";
}
// 読み込み: 1 本ずつ Worker で確かめ (1 本が CR_CHECK_MS で答えなければ、Worker を作り直してそのルールだけ断り、残りを続ける)、
// 通ったものだけで importRules の足し方 (同じルール・id・上限) を当てる。ファイル全体が読めないときは、今のルールを変えない
async function crImport(file) {
  crShowImport("読み込んでいます…", []);
  let text;
  try { text = await file.text(); } catch (_) {
    crShowImport(null, ["読み込めませんでした: ファイルを読めませんでした"]);
    return;
  }
  const worker = crWorker();
  try {
    const read = await worker.ask({ op: "read", text });
    if (!read.ok) {
      crShowImport(null, crReasons(read, "ファイルの確かめに時間がかかりすぎました").map((r) => `読み込めませんでした: ${r}`));
      return;
    }
    const passed = []; // 確かめを通ったルールと、ファイルの何番目か
    const rejected = []; // 断ったルールの { at (ファイルの何番目か), errors }
    for (let at = 0; at < read.rules.length; at++) {
      const answer = await worker.ask({ op: "check", rule: read.rules[at] });
      if (answer.failed) {
        crShowImport(null, [`読み込めませんでした: ${CR_UNAVAILABLE}`]);
        return;
      }
      if (answer.ok) passed.push({ rule: read.rules[at], at });
      else rejected.push({ at, errors: crReasons(answer, CR_TIMEOUT_REASON) });
    }
    // 通ったものは速いので、足し方は Worker の中で importRules に任せる (1 本ぶんの時間を、本数ぶん許す)
    const merged = await worker.ask({ op: "merge", rules: passed.map((p) => p.rule), existing: await crReadRules() }, CR_CHECK_MS * (passed.length + 1));
    if (!merged.ok) {
      crShowImport(null, crReasons(merged, "読み込みに時間がかかりすぎました").map((r) => `読み込めませんでした: ${r} (今のルールは変わっていません)`));
      return;
    }
    const { result } = merged;
    for (const r of result.rejected) rejected.push({ at: passed[r.index].at, errors: r.errors });
    if (result.added > 0) await crWriteRules(result.rules);
    rejected.sort((a, b) => a.at - b.at);
    crShowImport(
      `追加 ${result.added} 件、同じルール ${result.duplicates} 件、読み込めなかったもの ${rejected.length} 件`,
      rejected.flatMap((r) => r.errors.map((e) => `${r.at + 1} 件目: ${e}`)),
    );
  } finally { worker.stop(); }
}
async function crExport() {
  const blob = new Blob([CR.exportRules(await crReadRules())], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = CR_EXPORT_FILE;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Pro の出し分けと配線 ----
// renderProLicense から呼ぶ。ID が仮 (visible が false) なら、カードごと出さない。Pro でなければ、案内を出して操作を止める
function crApplyLicense(visible, pro) {
  const card = $("custom-rules-card");
  card.hidden = !visible || !CR;
  if (card.hidden) return;
  crPro = pro;
  $("cr-pro-note").hidden = pro;
  crSyncControls();
  if (!crListShown) {
    crListShown = true;
    crRenderList();
  }
}
function crInit() {
  if (!CR) return;
  crSyncKind();
  $("cr-kind").addEventListener("change", crSyncKind);
  $("cr-match").addEventListener("change", crUpdateAdvice);
  $("cr-words").addEventListener("input", crUpdateAdvice);
  $("cr-save").addEventListener("click", () => crRun(crSave));
  $("cr-cancel").addEventListener("click", () => {
    crResetForm();
    $("cr-status").textContent = "";
    crShowErrors([]);
  });
  $("cr-export").addEventListener("click", () => crExport());
  $("cr-import").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // 同じファイルをもう一度選んでも、change が起きるように
    if (file) crRun(() => crImport(file));
  });
  // 保存・削除・読み込み、別の設定画面からの変更のあとの一覧は、storage の変化で出し直す
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && CR.STORAGE_KEY in changes && crListShown) crRenderList();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // version / engine-version のプレースホルダを manifest から自動反映。
  try {
    const v = "v" + chrome.runtime.getManifest().version;
    const versionEl = $("version");
    if (versionEl) versionEl.textContent = v;
    const engineEl = $("engine-version");
    if (engineEl) engineEl.textContent = v;
  } catch (_) {}
  loadAllowlist();
  buildTintPalette();
  loadChatTint();
  loadEnabled();
  loadInteractive();
  loadUiMode();
  loadLlmSettings();
  loadMlSettings();
  crInit();
  loadProLicense(false);

  $("pro-upgrade").addEventListener("click", () => openProPage("license:openPayment"));
  $("pro-login").addEventListener("click", () => openProPage("license:openLogin"));
  $("pro-refresh").addEventListener("click", () => loadProLicense(true));
  // 購入状態が変わったら (60 分ごとの確かめ直しなど)、開いている設定画面にも出す
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "licenseState" in changes) loadProLicense(false);
  });
  $("allowlist-add-btn").addEventListener("click", () => {
    const input = $("allowlist-input");
    addToAllowlist(input.value);
    input.value = "";
    input.focus();
  });
  $("allowlist-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      addToAllowlist(e.target.value);
      e.target.value = "";
    }
  });

  $("clear-btn").addEventListener("click", clearAllowlist);
  $("export-btn").addEventListener("click", exportAllowlist);
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importAllowlist(file);
    e.target.value = "";
  });

  // 背景色: 色見本は押したらすぐ保存。任意の色は選び終わったとき (change) と、
  // ドラッグ中は 0.25 秒止まったときに保存する (開いているタブを毎回塗り直さないため)
  $("chat-tint-palette").addEventListener("change", (e) => {
    if (e.target && e.target.name === "chat-tint") saveChatTint(e.target.value);
  });
  $("chat-tint-custom-radio").addEventListener("change", () => saveChatTint($("chat-tint-custom").value));
  let tintInputTimer = null;
  $("chat-tint-custom").addEventListener("input", () => {
    $("chat-tint-custom-radio").checked = true;
    clearTimeout(tintInputTimer);
    tintInputTimer = setTimeout(() => saveChatTint($("chat-tint-custom").value), 250);
  });
  $("chat-tint-custom").addEventListener("change", () => {
    $("chat-tint-custom-radio").checked = true;
    clearTimeout(tintInputTimer);
    saveChatTint($("chat-tint-custom").value);
  });

  $("opt-enabled").addEventListener("change", (e) => {
    if (window.PiiGuardDiagLog) PiiGuardDiagLog.log("settings.enabled", { value: e.target.checked ? "on" : "off", via: "options" });
    chrome.storage.local.set({ enabled: e.target.checked });
  });
  $("opt-interactive").addEventListener("change", (e) => {
    chrome.storage.local.set({ interactive: e.target.checked });
  });
  document.querySelectorAll('input[name="ui-mode"]').forEach((r) => {
    r.addEventListener("change", (e) => {
      const value = e.target.value === "modal" ? "modal" : "sidebar";
      chrome.storage.local.set({ uiMode: value });
    });
  });

  $("llm-enabled").addEventListener("change", async (e) => {
    // Turning OFF is unconditional — no permission needed.
    if (!e.target.checked) {
      await chrome.storage.local.set({ localLlmEnabled: false });
      setLlmStatus("unknown", "無効化中");
      return;
    }
    // Turning ON: we're still inside the change-event user gesture,
    // so we can prompt for host permission if not already granted.
    const url = normalizeUrl($("llm-url").value);
    if (!url) {
      // No URL configured yet — allow enable; testLlm() / fetches will
      // re-request permission once the user enters a URL and clicks
      // 接続確認.
      await chrome.storage.local.set({ localLlmEnabled: true });
      setLlmStatus("unknown", "URL 未設定");
      return;
    }
    const granted = await ensureLlmHostPermission(url);
    if (!granted) {
      // Revert the toggle and keep stored flag at false. Setting
      // .checked directly here doesn't re-fire the change event.
      e.target.checked = false;
      await chrome.storage.local.set({ localLlmEnabled: false });
      setLlmStatus("err", "ホスト権限が拒否されました — LLM を有効化できません");
      return;
    }
    await chrome.storage.local.set({ localLlmEnabled: true });
    testLlm();
  });
  $("llm-test-btn").addEventListener("click", testLlm);
  $("llm-url").addEventListener("change", (e) => {
    const url = normalizeUrl(e.target.value);
    chrome.storage.local.set({ localLlmUrl: url });
    e.target.value = url;
  });
  $("llm-model").addEventListener("change", (e) => {
    chrome.storage.local.set({ localLlmModel: e.target.value });
  });
  $("llm-mode").addEventListener("change", (e) => {
    const v = e.target.value === "replace" ? "replace" : "detect";
    chrome.storage.local.set({ localLlmMode: v });
  });
  $("llm-timeout").addEventListener("change", (e) => {
    const n = Math.max(2000, Math.min(240000, parseInt(e.target.value, 10) || 120000));
    chrome.storage.local.set({ localLlmTimeoutMs: n });
    e.target.value = n;
  });

  // ML detection toggle. Same gesture-aware pattern as the LLM toggle:
  // OFF is unconditional; ON requests HF Hub host permission first
  // (if not already granted), then sets the storage flag, then kicks
  // off the model prewarm. The first prewarm downloads ~135 MB and
  // takes 10-90s depending on the network; subsequent loads are cached.
  const mlToggle = $("ml-enabled");
  if (mlToggle) {
    mlToggle.addEventListener("change", async (e) => {
      if (!e.target.checked) {
        await chrome.storage.local.set({ mlEnabled: false });
        setMlStatus("unknown", "未有効");
        return;
      }
      setMlStatus("checking", "ホスト権限を要求中…");
      const granted = await requestMlHostPermission();
      if (!granted) {
        e.target.checked = false;
        await chrome.storage.local.set({ mlEnabled: false });
        setMlStatus("err", "ホスト権限が拒否されました");
        return;
      }
      await chrome.storage.local.set({ mlEnabled: true });
      setMlStatus("checking", "モデルを取得中… (初回 10-90 秒)");
      prewarmMl();
    });
  }
});

// --- タブと動作ログ (docs/diagnostic-log.md の D-LG-07) --------------------------
// 表示は textContent だけで組む。記録の中身は diag-log.js の検めを通った決まった値だけ
const TABS = { settings: { btn: "tabbtn-settings", panel: "tab-settings" }, log: { btn: "tabbtn-log", panel: "tab-log" } };
const LEVEL_JA = { info: "情報", warn: "注意", error: "エラー" };
let logShown = [];
let logTimer = null;

function selectTab(name, focus) {
  for (const [key, t] of Object.entries(TABS)) {
    const on = key === name;
    const btn = $(t.btn);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    btn.tabIndex = on ? 0 : -1;
    $(t.panel).hidden = !on;
    if (on && focus) btn.focus();
  }
  try { history.replaceState(null, "", name === "log" ? "#log" : location.pathname); } catch (_) { /* 何もしない */ }
  if (name === "log") renderLog();
}

async function renderLog() {
  if (!DLOG) return;
  const days = Number($("log-days").value) || DLOG.RETENTION_DAYS;
  const warnOnly = $("log-level").value === "warn";
  let entries = [];
  try { entries = await DLOG.readAll(chrome.storage.local, { days }); } catch (e) { DLOG.log("error", DLOG.errorFields(e, "options")); }
  if (warnOnly) entries = entries.filter((e) => e.lv === "warn" || e.lv === "error");
  logShown = entries;
  const tbody = $("log-rows");
  tbody.textContent = "";
  for (const e of entries) {
    const tr = document.createElement("tr");
    const time = document.createElement("td");
    time.className = "log-time";
    time.textContent = DLOG.timeStr(e.t);
    const lvCell = document.createElement("td");
    const lv = document.createElement("span");
    lv.className = `lv lv-${e.lv}`;
    lv.textContent = LEVEL_JA[e.lv] || e.lv;
    lvCell.appendChild(lv);
    const site = document.createElement("td");
    site.className = "log-site";
    site.textContent = e.site || "拡張機能";
    const msg = document.createElement("td");
    msg.textContent = DLOG.format(e) + (e.n > 1 ? ` ×${e.n}` : "");
    if (e.src === "page") {
      const note = document.createElement("span");
      note.className = "log-note";
      note.textContent = "ページ側から報告";
      msg.appendChild(note);
    }
    tr.append(time, lvCell, site, msg);
    tbody.appendChild(tr);
  }
  $("log-empty").hidden = entries.length > 0;
}

function scheduleRenderLog() {
  clearTimeout(logTimer);
  logTimer = setTimeout(() => { if (!$("tab-log").hidden) renderLog(); }, 300);
}

document.addEventListener("DOMContentLoaded", () => {
  $("tabbtn-settings").addEventListener("click", () => selectTab("settings"));
  $("tabbtn-log").addEventListener("click", () => selectTab("log"));
  // 左右の矢印キーでタブを移る
  for (const id of ["tabbtn-settings", "tabbtn-log"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      selectTab(id === "tabbtn-settings" ? "log" : "settings", true);
    });
  }
  $("log-days").addEventListener("change", renderLog);
  $("log-level").addEventListener("change", renderLog);
  $("log-copy").addEventListener("click", async () => {
    const version = chrome.runtime.getManifest().version;
    const head = `PII Guard ${version} の動作ログ (${$("log-days").selectedOptions[0].textContent}、${$("log-level").selectedOptions[0].textContent})`;
    const text = [head, ...logShown.map((e) => DLOG.formatLine(e))].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      $("log-status").textContent = `${logShown.length} 件をコピーしました`;
    } catch (_) {
      $("log-status").textContent = "コピーできませんでした";
    }
  });
  $("log-clear").addEventListener("click", async () => {
    if (!confirm("動作ログをすべて消しますか？")) return;
    await DLOG.clear(chrome.storage.local);
    $("log-status").textContent = "動作ログを消しました";
    renderLog();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some((k) => k.startsWith("diagLog"))) scheduleRenderLog();
  });
  if (location.hash === "#log") selectTab("log");
});
