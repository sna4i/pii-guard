// Options page — full settings UI with mask allowlist database.
// Mirrors popup.js for shared toggles and adds CRUD + import/export
// for the maskAllowlist key in chrome.storage.local.

const $ = (id) => document.getElementById(id);

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
    console.warn("[ml] chrome.permissions API unavailable; falling back to true");
    return true;
  }
  try {
    if (await chrome.permissions.contains({ origins: ML_HF_ORIGINS })) return true;
  } catch (_) { /* fall through to request */ }
  try {
    return await chrome.permissions.request({ origins: ML_HF_ORIGINS });
  } catch (e) {
    console.warn("[ml] permission request failed:", e?.message || e);
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
    console.warn(
      "[pii-guard] chrome.permissions API unavailable — falling back to direct fetch for",
      pattern
    );
    return true;
  }
  try {
    const already = await chrome.permissions.contains({ origins: [pattern] });
    if (already) return true;
  } catch (err) {
    console.warn("[pii-guard] chrome.permissions.contains failed:", err);
    // Fall through and try request() — contains() failure shouldn't block.
  }
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    return granted === true;
  } catch (err) {
    console.warn("[pii-guard] chrome.permissions.request failed:", err);
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
  loadEnabled();
  loadInteractive();
  loadUiMode();
  loadLlmSettings();
  loadMlSettings();

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

  $("opt-enabled").addEventListener("change", (e) => {
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
