// tests/fixtures/mock-chatgpt/app.js — chatgpt.com を名乗るモックの画面 (ブラウザで動く)。
//
// 形の出どころ (spec 13.1 / AGENTS: 実物の形を写す):
//   - ログイン後の入力欄の段: 利用者が貼った実物の HTML (tests/integration/e2e-composer-toggle.mjs の
//     dockableComposer と同じ構造。[data-composer-footer-responsive] / [data-composer-input] /
//     div.ProseMirror[contenteditable] / [data-composer-navigation-target])
//   - prepare の本文: 利用者が観測した実物 (spec 1 章の JSON をそのまま使う)
//   - ログインなしの入力欄: 2026-10-18 に実サイトで読んだ DOM (textarea#mobile-composer-prompt,
//     button[data-composer-submit], form の CSS Grid)
// 実物で確かめていない点 (モックの仮定): ログイン後の送信ボタンの属性
// (#composer-submit-button[data-testid=send-button])、停止ボタン ([data-testid=stop-button])、
// conduit_token を会話の送信に付けるヘッダー名 (x-conduit-token)、ログインなしの送信先。
//
// ページのスクリプトとして「最悪の振る舞い」もできる (URL の ?telemetry=1 など):
// 入力欄の文字を beacon・FormData・XHR・WebSocket・Worker で送る。Secure Composer が
// 有効なら、ページ側の入力欄には原文が入らないので、どの経路にも原文は乗らないはず。
(() => {
  "use strict";
  const q = new URLSearchParams(location.search);
  const VARIANT = q.get("variant") === "loggedout" ? "loggedout" : "loggedin";
  const FLAGS = {
    telemetry: q.get("telemetry") === "1",
    ws: q.get("ws") === "1",
    worker: q.get("worker") === "1",
    draft: q.get("draft") === "1",
    prepareRequired: q.get("prepareRequired") === "1",
  };
  const PREPARE_DEBOUNCE_MS = 350;
  const MODEL = "gpt-6-thinking";
  const state = { conduitToken: null, streaming: false, prepareTimer: 0, prepareSeq: 0, sentCount: 0 };
  const W = window;
  W.__mock = { state, FLAGS, VARIANT, events: [] };
  const log = (type, extra) => W.__mock.events.push({ t: Date.now(), type, ...(extra || {}) });

  // ---- telemetry channels (adversarial) -----------------------------------
  let ws = null;
  if (FLAGS.ws) {
    try { ws = new WebSocket(`wss://${location.host}/backend-api/ws`); } catch (_) { ws = null; }
  }
  let worker = null;
  if (FLAGS.worker) {
    try { worker = new Worker("/mock/worker.js"); } catch (_) { worker = null; }
  }
  function leakEverywhere(text) {
    if (!text) return;
    if (FLAGS.telemetry) {
      try { navigator.sendBeacon("/ces/v1/t", JSON.stringify({ type: "composer_change", text })); } catch (_) {}
      try { const fd = new FormData(); fd.append("draft", text); fetch("/ces/v1/m", { method: "POST", body: fd }); } catch (_) {}
      try { const x = new XMLHttpRequest(); x.open("POST", "/ces/v1/x"); x.send(new Blob([text], { type: "text/plain" })); } catch (_) {}
      try { fetch(new Request("/ces/v1/r?d=" + encodeURIComponent(text.slice(0, 64)), { method: "GET" })); } catch (_) {}
    }
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: "draft", text })); } catch (_) {} }
    if (worker) { try { worker.postMessage(text); } catch (_) {} }
  }

  // ---- composer -------------------------------------------------------------
  const root = document.getElementById("composer-root");
  let editor = null;
  let sendBtn = null;
  let stopBtn = null;
  let voiceBtn = null;

  function editorText() {
    if (!editor) return "";
    if (editor.tagName === "TEXTAREA") return editor.value;
    return (editor.innerText || "").replace(/\n+$/, "");
  }
  function clearEditor() {
    if (!editor) return;
    if (editor.tagName === "TEXTAREA") editor.value = "";
    else editor.innerHTML = "<p><br></p>";
    refreshButtons();
  }
  function refreshButtons() {
    const has = editorText().trim().length > 0;
    if (sendBtn) { sendBtn.hidden = !has || state.streaming; sendBtn.disabled = !has || state.streaming; }
    if (voiceBtn) voiceBtn.hidden = has || state.streaming;
    if (stopBtn) stopBtn.hidden = !state.streaming;
  }

  function buildLoggedIn() {
    // 実物の HTML (利用者が貼ったもの) と同じ入れ子。クラス名の末尾のハッシュはビルドごとに変わる
    root.innerHTML = `<form class="composer-form" data-type="unified-composer"><div class="surface"><div class="ComposerLayoutFooter-_8IVRO" data-composer-footer-responsive="" data-composer-layout="single-line">
<div class="min-w-0"><div class="flex min-w-0 items-center gap5"><div class="flex items-center"><span data-state="closed" class="contents"><button type="button" class="btn" aria-label="ファイルなどを追加" data-composer-navigation-target="add-context">+</button></span></div></div></div>
<div class="min-w-0"><div data-composer-input=""><div contenteditable="true" role="textbox" id="prompt-textarea" class="ProseMirror" aria-label="ChatGPT に聞く" data-placeholder="ChatGPT に聞く"><p><br></p></div></div></div>
<div class="min-w-0"><div class="contents"><div class="flex min-w-0 items-center"><div class="flex min-w-0 justify-end"><div class="flex items-center"><span data-state="closed" class="contents"><button type="button" aria-label="ChatGPT モデルを選択" data-composer-navigation-target="reasoning" class="pill">思考量 中程度</button></span>
<button type="button" class="btn" aria-label="音声入力"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><use href="/cdn/assets/icons-9453d99f50597150.svg#microphone-light-16" fill="currentColor"></use></svg>🎤</button>
<button type="button" class="btn round" data-testid="voice-button" aria-label="音声モードを開始する">◉</button>
<button type="submit" id="composer-submit-button" data-testid="send-button" class="btn round dark" aria-label="プロンプトを送信する" hidden>↑</button>
<button type="button" data-testid="stop-button" class="btn round dark" aria-label="ストリーミングの停止" hidden>■</button>
</div></div></div></div></div></div></div></form>`;
    editor = root.querySelector("#prompt-textarea");
    sendBtn = root.querySelector('[data-testid="send-button"]');
    stopBtn = root.querySelector('[data-testid="stop-button"]');
    voiceBtn = root.querySelector('[data-testid="voice-button"]');
  }

  function buildLoggedOut() {
    // 2026-10-18 に実サイト (ログインなし) で読んだ DOM の要素と属性
    root.innerHTML = `<form class="x1lo-grid" style="display:grid;grid-template-columns:36px minmax(0,630px) 80px;grid-template-areas:'leading primary trailing';align-items:end">
<div style="grid-area:leading"><button type="button" data-composer-action="" aria-label="ファイルを追加">+</button></div>
<div style="grid-area:primary"><textarea class="x-default-marker" aria-label="ChatGPT とチャット" autocapitalize="sentences" autocomplete="off" autocorrect="on" data-mobile-composer-prompt="" enterkeyhint="enter" id="mobile-composer-prompt" inputmode="text" name="prompt" placeholder="ChatGPT に聞く" required="" rows="1" spellcheck="true"></textarea></div>
<div style="grid-area:trailing"><button type="submit" data-composer-submit="" aria-label="送信" disabled>↑</button><button type="button" data-testid="stop-button" hidden>■</button></div>
</form>`;
    editor = root.querySelector("#mobile-composer-prompt");
    sendBtn = root.querySelector("[data-composer-submit]");
    stopBtn = root.querySelector('[data-testid="stop-button"]');
    voiceBtn = null;
  }

  function mountComposer() {
    if (VARIANT === "loggedout") buildLoggedOut(); else buildLoggedIn();
    const form = root.querySelector("form");
    form.appendChild(imageInput);  // 実物と同じく、入力欄の form の中に画像用 → 汎用の順
    form.appendChild(attachInput);
    form.addEventListener("submit", (e) => { e.preventDefault(); submit("button"); });
    if (sendBtn && sendBtn.type !== "submit") sendBtn.addEventListener("click", () => submit("button"));
    editor.addEventListener("input", onInput);
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit("enter");
      }
    });
    if (FLAGS.draft) {
      // ChatGPT は下書きをページの保存領域に残す。読み込み時に入力欄へ戻す
      const d = localStorage.getItem("mock-draft:" + location.pathname);
      if (d) {
        if (editor.tagName === "TEXTAREA") editor.value = d; else editor.innerText = d;
        log("draft-restored", { len: d.length });
        onInput();
      }
    }
    refreshButtons();
    log("composer-mounted", { variant: VARIANT });
  }

  function onInput() {
    const text = editorText();
    refreshButtons();
    if (FLAGS.draft) localStorage.setItem("mock-draft:" + location.pathname, text);
    leakEverywhere(text);
    if (VARIANT === "loggedout") return; // 実サイトのログインなしでは prepare を観測していない
    clearTimeout(state.prepareTimer);
    state.prepareTimer = setTimeout(() => { if (editorText().trim()) prepare("debounced"); }, PREPARE_DEBOUNCE_MS);
  }

  async function prepare(dispatch) {
    const text = editorText();
    const body = {
      client_prepare_state: "sent",
      action: "next",
      model: MODEL,
      partial_query: { author: { role: "user" }, content: { content_type: "text", parts: [text] } },
      client_prepare_dispatch: dispatch,
      client_prepare_source: "composer_editor_state",
    };
    const seq = ++state.prepareSeq;
    log("prepare-start", { seq, dispatch });
    try {
      const r = await fetch("/backend-api/f/conversation/prepare", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j && j.conduit_token) state.conduitToken = j.conduit_token;
      log("prepare-ok", { seq });
      return true;
    } catch (e) {
      log("prepare-failed", { seq, error: String(e && e.message || e) });
      return false;
    }
  }

  // 添付 (実物の ChatGPT を模す): file input → 中身を読んでサーバへ PUT 相当で送る。
  // attachment-guard が change を横取りしてマスク済み File に差し替えていれば、ここで読む
  // 中身はマスク済みになる (実物も input.files を読んでアップロードする)。
  // 実物 (2026-10-18 ログイン後) と同じく、入力欄の form の中に「画像だけ」の input が先に並び、
  // その後ろに accept 無し・multiple の汎用 input がある (mountComposer が form に差し込む)。
  async function uploadFiles(files, via) {
    for (const f of files) {
      let text = "";
      try { text = await f.text(); } catch (_) {}
      log(via, { name: f.name, bytes: f.size });
      // 実物の presigned PUT 相当: 中身をサーバに送る (テストが受信内容を検査する)
      try { await fetch("/backend-api/files/content", { method: "POST", headers: { "content-type": "text/plain" }, body: text }); } catch (_) {}
    }
  }
  const imageInput = document.createElement("input");
  imageInput.type = "file";
  imageInput.accept = "image/*";
  imageInput.id = "mock-image-file";
  imageInput.style.display = "none";
  imageInput.addEventListener("change", () => uploadFiles(Array.from(imageInput.files || []), "image-upload"));
  const attachInput = document.createElement("input");
  attachInput.type = "file";
  attachInput.id = "mock-file";
  attachInput.multiple = true;
  attachInput.setAttribute("data-testid", "file-input");
  attachInput.style.cssText = "position:fixed;bottom:4px;left:4px;opacity:0.01;width:40px";
  attachInput.addEventListener("change", () => uploadFiles(Array.from(attachInput.files || []), "attach-upload"));

  // ドラッグ&ドロップ (実物を模す): ページ全体で受けてオーバーレイを出し、落ちたファイルを
  // そのままアップロードする。attachment-guard が drop を先に捕まえなければ原文が出る (F-SC-13)。
  // オーバーレイは react-dropzone と同じく dragenter/dragleave の対で出し入れする。
  (function setupDrop() {
    const overlay = document.createElement("div");
    overlay.id = "mock-drop-overlay";
    overlay.textContent = "ここにファイルをドロップすると、会話に追加されます";
    overlay.style.cssText = "position:fixed;inset:0;z-index:40;pointer-events:none;display:none;background:rgba(0,0,0,.15)";
    document.body.appendChild(overlay);
    let targets = [];
    const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    const show = (v) => { overlay.style.display = v ? "block" : "none"; };
    document.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (!targets.includes(e.target)) targets.push(e.target); show(true); });
    document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener("dragleave", (e) => { e.preventDefault(); targets = targets.filter((t) => t !== e.target && t.isConnected); if (!targets.length) show(false); });
    document.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []); // イベント中に取り出す
      targets = []; show(false);
      log("drop-received", { count: files.length });
      uploadFiles(files, "drop-upload");
    });
  })();

  function addMessage(role, text, extra) {
    const thread = document.getElementById("thread");
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.setAttribute("data-message-author-role", role);
    div.textContent = text;
    if (extra) div.appendChild(extra);
    thread.appendChild(div);
    return div;
  }

  async function submit(via) {
    const text = editorText();
    if (!text.trim() || state.streaming) return;
    log("submit", { via, len: text.length });
    clearTimeout(state.prepareTimer);
    if (VARIANT !== "loggedout" && !state.conduitToken) {
      await Promise.race([prepare("immediate"), new Promise((r) => setTimeout(r, 2000))]);
    }
    await sendConversation(text);
  }

  async function sendConversation(text) {
    const url = VARIANT === "loggedout" ? "/backend-anon/f/conversation" : "/backend-api/f/conversation";
    const body = {
      action: "next",
      messages: [{ id: "m-" + (++state.sentCount), author: { role: "user" }, content: { content_type: "text", parts: [text] } }],
      parent_message_id: "client-created-root",
      model: MODEL,
    };
    const headers = { "content-type": "application/json", accept: "text/event-stream" };
    if (state.conduitToken) headers["x-conduit-token"] = state.conduitToken;
    state.streaming = true;
    clearEditor();
    if (FLAGS.draft) localStorage.removeItem("mock-draft:" + location.pathname);
    addMessage("user", text);
    const reply = addMessage("assistant", "");
    try {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.replace(/^data: /, "");
          if (line === "[DONE]") continue;
          try { const j = JSON.parse(line); reply.textContent = j.message.content.parts[0]; } catch (_) {}
        }
      }
      state.conduitToken = null; // 次の送信では新しい prepare が要る
      log("conversation-ok");
    } catch (e) {
      reply.remove();
      const retry = document.createElement("button");
      retry.type = "button"; retry.textContent = "再試行"; retry.setAttribute("data-testid", "retry-button");
      retry.addEventListener("click", () => { retry.parentElement.remove(); sendConversation(text); });
      addMessage("error", "エラーが発生しました: " + String(e && e.message || e) + " ", retry);
      log("conversation-failed", { error: String(e && e.message || e) });
    } finally {
      state.streaming = false;
      refreshButtons();
    }
  }

  // ---- SPA navigation (React の作り直しを真似る) -------------------------------
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-nav]");
    if (!a) return;
    e.preventDefault();
    history.pushState({}, "", a.getAttribute("href"));
    document.getElementById("thread").textContent = "";
    mountComposer(); // 入力欄の要素を作り直す
    log("navigated", { path: location.pathname });
  });
  W.__mock.remountComposer = mountComposer;

  mountComposer();
  // 本物の ChatGPT と同じく、読み込み直後に入力欄へフォーカスする
  setTimeout(() => { try { editor.focus(); } catch (_) {} }, 50);
})();
