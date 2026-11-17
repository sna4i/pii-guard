// options-custom-rules.js — 設定画面の Pro のカスタムルールのカード (Pro Phase 2 の設計 (P1)、T-CR-41〜51)
//
// ルールを足す・直す・消す・書き出す・読み込むのは、ここだけ。Pro かどうかは #pro-card と同じ license:get の答えで、
// options.js の renderProLicense が window.PiiGuardCustomRules.apply に渡す。ID が仮の版ではカードごと出さず、Worker も立てない。
// 画面は普通のスクリプトとして読み込む (options.html で、engine/custom-rules.js のあと・options.js の前)。
// options.js が使うのは、apply (Pro の出し分け) と init (操作の配線) の 2 つだけ。
//
// 保存と読み込みの確かめ (validateRule・stressTest・importRules) は、この画面のスレッドでは走らせない。
// 正規表現の 1 回の照合は途中で止められず、時間を食う形が通り抜けると、試したとたんに設定画面ごと固まるため。
// options-rules-worker.js (Worker) に 1 本ずつ頼み、CR_CHECK_MS たっても答えが来なければ、Worker を止めて作り直し、
// そのルールだけを「時間がかかりすぎる正規表現です」で断る。ここで使う engine/custom-rules.js の部品は、定数
// (LIMITS・STORAGE_KEY) と exportRules (JSON にするだけで、正規表現は動かさない) だけ。
// 一覧・エラー・結果は textContent だけで組む (利用者の文字を innerHTML に入れない)。
"use strict";

(function attach(root) {
  const $ = (id) => document.getElementById(id);

  const CR = (window.__localMaskMCP && window.__localMaskMCP.engine && window.__localMaskMCP.engine.customRules) || null;
  const CR_CHECK_MS = 1000; // ルール 1 本の確かめを待つ時間 (読み込み全体ではなく、1 本ごと)
  const CR_TIMEOUT_REASON = "時間がかかりすぎる正規表現です";
  const CR_UNAVAILABLE = "確かめる処理を始められませんでした。設定画面を開き直してください";
  const CR_EXPORT_FILE = "pii-guard-custom-rules.json";
  // ハイフン類で断られたときに足す、書き直しの例 (どれも validateRule を通る)
  const CR_HYPHEN_EXAMPLES = ["[ァ-ヶー-]", "[ァ-ヶ][ァ-ヶー]*", "[ー-]"];
  // 完全一致の文字の種類のうち「ひらがな」。ー はカタカナの仲間なので、ここには入らない
  const CR_HIRAGANA = /^\p{Script=Hiragana}$/u;

  let crPro = false; // 今 Pro か。false のあいだは、足す・変える操作を止める (書き出しと削除は使える)
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
  // カードの操作は、最中でないときだけ押せる。Pro でないときは、足す・変える操作 (フォーム・保存・読み込み・有効の切り替え・編集) を
  // 止めて、一覧を読むだけの形にする。書き出しと、各ルールの削除は、Pro でなくても使える
  // (ルールには顧客名などが入りうる。自分のデータを持ち出す手段と、消す手段は残す)
  function crSyncControls() {
    for (const el of $("custom-rules-card").querySelectorAll("input, select, textarea, button")) {
      const usableWithoutPro = el.id === "cr-export" || el.classList.contains("cr-delete");
      el.disabled = crBusy || (!crPro && !usableWithoutPro);
    }
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
    // 追加か編集か (と、編集ならどのルールのどの形か) は、Worker を待つ前に決める。待つあいだに別の画面がそのルールを
    // 変えると、一覧の出し直しで編集が終わる (crEditing が null になる) が、ここで持った snapshot の照合 (crChangeRule) が断る。
    // 待ったあとに決めると、同じ id のまま新しいルールとして足してしまう
    const editing = crEditing;
    const worker = crWorker();
    let answer;
    try { answer = await worker.ask({ op: "check", rule: crFormRule() }); } finally { worker.stop(); }
    status.textContent = "";
    if (!answer.ok) {
      crShowErrors(crReasons(answer, CR_TIMEOUT_REASON));
      return;
    }
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
  // renderProLicense から呼ぶ。ID が仮 (visible が false) なら、カードごと出さない。Pro でなければ、案内を出して、足す・変える操作を止める
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

  root.PiiGuardCustomRules = { apply: crApplyLicense, init: crInit };
})(window);
