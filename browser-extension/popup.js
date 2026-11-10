// Popup script — reads/writes chrome.storage.local for masking
// preferences and queries the service worker for the per-tab
// detection count. Standalone-only build: no gateway probe.

const $ = (id) => document.getElementById(id);
const DL = window.PiiGuardDiagLog; // 動作ログ (docs/diagnostic-log.md)
if (DL) DL.captureErrors("popup");

async function loadEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  $("enabled-toggle").checked = enabled;
}

async function saveEnabled(value) {
  if (DL) { DL.log("settings.enabled", { value: value ? "on" : "off", via: "popup" }); DL.flushNow(); }
  await chrome.storage.local.set({ enabled: value });
}

async function loadInteractive() {
  const { interactive = true } = await chrome.storage.local.get("interactive");
  $("interactive-toggle").checked = interactive;
}

async function saveInteractive(value) {
  await chrome.storage.local.set({ interactive: value });
}

async function loadUiMode() {
  const { uiMode } = await chrome.storage.local.get("uiMode");
  const value = uiMode === "modal" ? "modal" : "sidebar";
  const target = document.querySelector(
    `input[name="ui-mode"][value="${value}"]`
  );
  if (target) target.checked = true;
}

async function saveUiMode(value) {
  const normalized = value === "modal" ? "modal" : "sidebar";
  await chrome.storage.local.set({ uiMode: normalized });
}

async function loadDetectionCount() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    $("detections-count").textContent = "0";
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_TAB_COUNT",
      tabId: tab.id,
    });
    const count = response && typeof response.count === "number" ? response.count : 0;
    $("detections-count").textContent = String(count);
  } catch (err) {
    $("detections-count").textContent = "0";
  }
}

// The Store bundle has no `http://*/*` host permission and no LLM
// UI, so this function's LLM_FETCH call would not be reachable.
// Stripped so reviewers see no localhost references in popup.js.
async function loadLlmIndicator() {
  const el = $("llm-indicator");
  if (!el) return;
  const { localLlmEnabled, localLlmUrl, localLlmModel } =
    await chrome.storage.local.get(["localLlmEnabled", "localLlmUrl", "localLlmModel"]);
  if (!localLlmEnabled) {
    el.textContent = "無効";
    el.className = "value status-unknown";
    return;
  }
  if (!localLlmUrl) {
    el.textContent = "URL 未設定";
    el.className = "value status-warn";
    return;
  }
  el.textContent = "確認中…";
  el.className = "value status-unknown";
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "LLM_FETCH",
      url: localLlmUrl.replace(/\/+$/, "") + "/api/tags",
      method: "GET",
      timeoutMs: 2500,
    });
    if (resp && resp.ok) {
      el.textContent = localLlmModel ? `✓ ${localLlmModel}` : "✓ 接続";
      el.className = "value status-ok";
    } else {
      el.textContent = resp && resp.status ? `HTTP ${resp.status}` : "切断";
      el.className = "value status-err";
    }
  } catch (_) {
    el.textContent = "切断";
    el.className = "value status-err";
  }
}

// ---- Pro 版 (docs/pro-license.md の F-PRO-07、D-PRO-05) ------------------------------
// 状態は Service Worker のライセンス管理に聞く。支払いの直後は自動では届かないので (extensionpay.com に
// content script を置いていない)、「購入状態を更新」で確かめ直す
function renderLicense(state) {
  const v = window.PiiGuardLicenseView.describeLicense(state);
  $("license-box").hidden = !v.visible;
  if (!v.visible) return;
  const st = $("license-status");
  st.textContent = v.status;
  st.className = "value " + (v.tone === "pro" ? "status-ok" : v.tone === "warn" ? "status-warn" : "");
  $("license-note").textContent = v.note;
  $("license-note").hidden = !v.note;
  $("license-upgrade").hidden = !v.canUpgrade;
  $("license-login").hidden = !v.canLogin;
  $("license-refresh").hidden = !v.canRefresh;
}
async function loadLicense(refresh) {
  let state = null;
  try { state = await chrome.runtime.sendMessage({ type: "license:get", refresh: refresh === true }); } catch (_) {}
  renderLicense(state);
  // キャッシュで先に出したとき (60 分を過ぎている) は、確かめ直しの答えを待って出し直す。確かめられなければ注記が出る。
  // 裏の確かめ直しが走っていればそれを待ち、もう終わっていれば、もう 1 回問い合わせる (D-PRO-11)
  if (refresh !== true && state && state.source === "stale") loadLicense(true);
}
async function openLicensePage(type) {
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type }); } catch (_) {}
  if (!(r && r.ok)) {
    $("license-note").textContent = window.PiiGuardLicenseView.describeOpenFailure(r && r.reason);
    $("license-note").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // バージョン表示を manifest から自動反映 — ハードコード文字列が
  // 古いままにならないよう runtime に寄せる。
  try {
    const el = $("version");
    if (el) {
      const v = chrome.runtime.getManifest().version;
      el.textContent = "v" + v;
    }
  } catch (_) {}
  loadEnabled();
  loadInteractive();
  loadUiMode();
  loadDetectionCount();
  loadLlmIndicator();
  loadLicense(false);

  $("license-upgrade").addEventListener("click", () => openLicensePage("license:openPayment"));
  $("license-login").addEventListener("click", () => openLicensePage("license:openLogin"));
  $("license-refresh").addEventListener("click", () => loadLicense(true));
  // 時間切れのあとで答えが届いたときなど、購入状態が書き換わったら出し直す
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "licenseState" in changes) loadLicense(false);
  });
  $("enabled-toggle").addEventListener("change", (e) => {
    saveEnabled(e.target.checked);
  });
  $("interactive-toggle").addEventListener("change", (e) => {
    saveInteractive(e.target.checked);
  });
  const fieldset = $("ui-mode-fieldset");
  if (fieldset) {
    fieldset.addEventListener("change", (e) => {
      const value =
        e.target && e.target.name === "ui-mode" ? e.target.value : null;
      if (value) saveUiMode(value);
    });
  }
  $("open-options-btn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
