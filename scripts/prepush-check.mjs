#!/usr/bin/env node
// scripts/prepush-check.mjs — GitHub に push する前に、公開してはいけない
// 内容が含まれていないかを検査する。.githooks/pre-push から呼ばれる。
//
//   node scripts/prepush-check.mjs --range origin/main..HEAD    # 手動で検査
//   node scripts/prepush-check.mjs --hook <remote> [<url>]      # pre-push から (stdin に更新対象)
//
// 終了コード: 0 = 問題なし / 1 = 違反あり (push を止める) / 2 = 使い方の誤り・内部エラー
//
// ルールの一覧 (PP-01〜PP-09) と、引っかかったときの直し方は
// docs/prepush-check.md にまとめてある。
//
// 検査は push される「コミットごと」に行う。最終的なツリーだけを見ると、
// あるコミットで入れて次のコミットで消した値を見逃すが、履歴ごと公開される。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIZE_LIMIT = 5 * 1024 * 1024;
const BINARY_SCAN_LIMIT = 64 * 1024 * 1024;
const ALLOW_MARKER = "prepush:allow";
const GITLEAKS_IMAGE = process.env.PREPUSH_GITLEAKS_IMAGE || "zricethezav/gitleaks:v8.30.1";
const DOCKER = process.env.PREPUSH_DOCKER || "docker";

const RULES = {
  "PP-01": "コミットの作者・コミッタが個人のメールアドレス",
  "PP-02": "この端末に固有の情報 (ホームのパス・利用者名・ホスト名)",
  "PP-03": "個人の禁止語リストにある文字列",
  "PP-04": "個人のメールアドレス",
  "PP-05": "私的なネットワークの識別子 (Tailscale)",
  "PP-06": "秘密情報 (gitleaks)",
  "PP-07": "生成物・端末ローカルのファイル",
  "PP-08": "5 MiB を超えるファイル",
  "PP-09": "目視確認が必要な画像・PDF",
};

// ---------------------------------------------------------------------------
// git

function git(args, { input, buffer = false } = {}) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    input,
    encoding: buffer ? null : "utf8",
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const commitExists = (sha) =>
  spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" }).status === 0;

function revList(revArgs) {
  const out = git(["rev-list", "--reverse", ...revArgs]).trim();
  return out ? out.split("\n") : [];
}

// pre-push の stdin: "<local ref> <local sha> <remote ref> <remote sha>" を 1 行ずつ
function updatesFromHook(remote, stdin) {
  const updates = [];
  for (const line of stdin.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const [, localSha, , remoteSha] = f;
    if (/^0+$/.test(localSha)) continue; // リモートのブランチ削除: 送る内容はない
    const known = !/^0+$/.test(remoteSha) && commitExists(remoteSha);
    // 新しいブランチや、手元に無いリモートの先端 (force push) では、
    // リモートのどの参照からも辿れないコミットを対象にする。
    updates.push(known ? [`${remoteSha}..${localSha}`] : [localSha, "--not", `--remotes=${remote}`]);
  }
  return updates;
}

// ---------------------------------------------------------------------------
// この端末に固有の文字列 (PP-02)

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GENERIC_HOSTS = /^(localhost|ubuntu|debian|fedora|raspberrypi|docker-desktop)$/i;
const WINDOWS_SYSTEM_USERS = /^(all users|default|default user|public|desktop\.ini|defaultuser\d*|wdagutilityaccount)$/i;

function machinePatterns() {
  const users = new Set();
  for (const u of [process.env.USER, process.env.LOGNAME, safe(() => os.userInfo().username)]) {
    if (u && u !== "root") users.add(u);
  }
  // WSL では Windows 側の利用者名も端末固有 (C:\Users\<名前>)
  for (const u of safe(() => fs.readdirSync("/mnt/c/Users")) || []) {
    if (!WINDOWS_SYSTEM_USERS.test(u)) users.add(u);
  }
  const SEP = String.raw`(?:\\{1,2}|/)`; // JSON や JS 文字列ではバックスラッシュが二重になる
  const HOME_PREFIX = String.raw`(?:/home/|/Users/|/mnt/[a-z]/Users/|[A-Za-z]:${SEP}Users${SEP}|\\{1,2}home\\{1,2})`;
  const pats = [];
  for (const u of users) {
    pats.push(new RegExp(`${HOME_PREFIX}${esc(u)}(?![A-Za-z0-9_-])`, "i"));
    pats.push(new RegExp(`-home-${esc(u)}-`, "i")); // Claude Code がパスを符号化した形
    if (u.length >= 5) pats.push(new RegExp(`(?<![A-Za-z0-9_])${esc(u)}(?![A-Za-z0-9_])`, "i"));
  }
  const home = process.env.HOME || os.homedir();
  if (home && home.length > 1) pats.push(new RegExp(`${esc(home)}(?![A-Za-z0-9_-])`));
  const host = os.hostname();
  if (host.length >= 5 && !GENERIC_HOSTS.test(host)) {
    pats.push(new RegExp(`(?<![A-Za-z0-9_-])${esc(host)}(?![A-Za-z0-9_-])`, "i"));
  }
  pats.push(/\/tmp\/claude-\d+\//); // Claude Code の作業領域
  return pats;
}

function safe(fn) {
  try { return fn(); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// 個人の禁止語リスト (PP-03)
//
// 氏名・個人のメールアドレスなど、「これだけは絶対に出さない」文字列を
// 1 行に 1 つ書く。リストそのものを公開しないよう、既定の置き場所は
// .git/info/prepush-denylist (push されない)。

function denylistPatterns() {
  const file = process.env.PREPUSH_DENYLIST || git(["rev-parse", "--git-path", "info/prepush-denylist"]).trim();
  const text = safe(() => fs.readFileSync(file, "utf8"));
  if (text === undefined) return { file, pats: [] };
  const pats = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(esc(l), "i"));
  return { file, pats };
}

// ---------------------------------------------------------------------------
// 文字列の規則 (PP-04, PP-05)

const FREEMAIL = ["gmail.com", "googlemail.com", "yahoo.co.jp", "yahoo.com", "ymail.com",
  "outlook.com", "outlook.jp", "hotmail.com", "hotmail.co.jp", "live.com", "live.jp", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.de", "mail.com", "docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp",
  "i.softbank.jp", "ymobile.ne.jp", "nifty.com", "biglobe.ne.jp", "so-net.ne.jp", "ocn.ne.jp"];
const PERSONAL_EMAIL = new RegExp(`[A-Za-z0-9._%+-]+@(?:${FREEMAIL.map(esc).join("|")})(?![A-Za-z0-9-])`, "i");

const TAILSCALE = [
  // CGNAT 範囲 (100.64/10)。このファイル自身が引っかからないよう、例は IP の形で書かない
  /(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}(?![\d])/,
  /\bfd7a:115c:a1e0:/i,
  /[A-Za-z0-9-]+\.ts\.net(?![A-Za-z0-9-])/i, // MagicDNS
];

// テストの入力データには、検出器の試験のために架空の個人情報を置く
const FIXTURE_PATH = /^tests\/|(^|\/)(__fixtures__|fixtures)\/|(^|\/)test-[^/]*$/;

// ---------------------------------------------------------------------------
// ファイル単位の規則 (PP-07, PP-08, PP-09)

const ARTIFACTS = [
  [/(^|\/)__pycache__\/|\.py[co]$/, "Python のキャッシュ"],
  [/(^|\/)[^/]+\.egg-info\//, "Python のパッケージ情報 (egg-info)"],
  [/\.(zip|crx|xpi)$/i, "配布用のパッケージ"],
  [/(^|\/)node_modules\//, "node_modules"],
  [/^(dev|dist)\//, "ビルドの出力 (dev/, dist/)"],
  [/(^|\/)\.tmp-profile-|(^|\/)\.playwright-mcp\//, "ブラウザのプロファイル"],
  [/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i, "OS が作るファイル"],
  [/(^|\/)\.env(\.(?!example$)[^/]+)?$/, "環境変数のファイル"],
  // gitleaks は拡張子の無いファイルに入った短い乱数を秘密と判定できない
  // (data/admin_token が初回コミットから公開されていた)
  // tests/ の中は検出器の試験データ (tests/vectors/secret.json など) なので対象外
  [/^(?!tests\/)(?:.*\/)?(?:[^/.]*_token|(?:credentials|secrets?)\.(?:json|ya?ml|txt))$/i, "トークン・認証情報のファイル"],
  [/^data\//, "ゲートウェイの実行時データ (管理トークン・監査ログ・実行時設定)"],
  [/\.(pem|p12|pfx)$/i, "鍵・証明書のファイル"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, "SSH の秘密鍵"],
  [/(^|\/)\.claude\/(worktrees|projects)\/|(^|\/)\.claude\/settings\.local\.json$/, "Claude Code の端末ローカルのファイル"],
];
const LARGE_FILE_ALLOWED = /^browser-extension\/vendor\//; // 同梱の推論ランタイム (wasm)
const NEEDS_REVIEW = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif|pdf)$/i;

// ---------------------------------------------------------------------------
// 検査本体

class Checker {
  constructor() {
    this.machine = machinePatterns();
    this.deny = denylistPatterns();
    this.violations = [];
    this.notes = [];
    this.imagesReviewed = process.env.PREPUSH_IMAGES_REVIEWED === "1";
    this.emptyTree = git(["hash-object", "-t", "tree", "/dev/null"]).trim();
  }

  add(rule, sha, loc, excerpt = "") {
    this.violations.push({ rule, sha: sha.slice(0, 7), loc, excerpt: excerpt.trim().slice(0, 160) });
  }

  // 1 行の文字列に対する規則。規則ごとに最初の一致だけを記録する。
  scanLine(text, sha, loc, { exempt = false } = {}) {
    const hit = (pats) => pats.find((p) => p.test(text));
    if (hit(this.deny.pats)) this.add("PP-03", sha, loc, text);
    if (hit(this.machine)) this.add("PP-02", sha, loc, text);
    if (exempt || text.includes(ALLOW_MARKER)) return;
    if (PERSONAL_EMAIL.test(text)) this.add("PP-04", sha, loc, text);
    if (hit(TAILSCALE)) this.add("PP-05", sha, loc, text);
  }

  checkCommit(sha) {
    const [ae, ce, an, cn, parents, ...msg] = git(["show", "-s", "--format=%ae%n%ce%n%an%n%cn%n%P%n%B", sha]).split("\n");
    for (const [role, email] of [["作者", ae], ["コミッタ", ce]]) {
      if (!/@users\.noreply\.github\.com$/i.test(email) && email.toLowerCase() !== "noreply@github.com") {
        this.add("PP-01", sha, `${role}のメール`, email);
      }
    }
    for (const name of [an, cn]) if (this.deny.pats.some((p) => p.test(name))) this.add("PP-03", sha, "作者名", name);
    msg.forEach((line, i) => this.scanLine(line, sha, `コミットメッセージ ${i + 1} 行目`, { exempt: false }));

    // マージコミットは第 1 親との差分 (ブランチに新しく入る内容) を見る
    const base = parents.trim() ? parents.trim().split(" ")[0] : this.emptyTree;
    const files = this.changedFiles(base, sha);
    this.checkFiles(sha, files);
    this.scanAddedLines(base, sha);
    return files.length > 0 && parents.trim().split(" ").length <= 1;
  }

  changedFiles(base, sha) {
    const raw = git(["diff-tree", "-r", "-z", "--no-renames", "--raw", base, sha]).split("\0");
    const numstat = git(["diff-tree", "-r", "-z", "--no-renames", "--numstat", base, sha]).split("\0");
    const binary = new Set();
    for (const rec of numstat) {
      const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
      if (m && m[1] === "-") binary.add(m[3]);
    }
    const files = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const head = raw[i].split(" ");
      if (head.length < 5) continue;
      const [, newMode, , blob, status] = head;
      files.push({ path: raw[i + 1], mode: newMode, blob, status, binary: binary.has(raw[i + 1]) });
    }
    return files;
  }

  checkFiles(sha, files) {
    const present = files.filter((f) => f.status !== "D" && f.mode !== "160000");
    const sizes = new Map();
    if (present.length) {
      const out = git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], { input: present.map((f) => f.blob).join("\n") + "\n" });
      for (const l of out.trim().split("\n")) { const [id, n] = l.split(" "); sizes.set(id, Number(n)); }
    }
    for (const f of present) {
      this.scanLine(f.path, sha, `ファイル名 ${f.path}`, { exempt: true });
      const artifact = ARTIFACTS.find(([re]) => re.test(f.path));
      if (artifact) this.add("PP-07", sha, f.path, artifact[1]);
      const size = sizes.get(f.blob) || 0;
      if (size > SIZE_LIMIT && !LARGE_FILE_ALLOWED.test(f.path)) {
        this.add("PP-08", sha, f.path, `${(size / 1024 / 1024).toFixed(1)} MiB`);
      }
      if (NEEDS_REVIEW.test(f.path)) {
        if (this.imagesReviewed) this.notes.push(`目視確認済みとして通します: ${f.path}`);
        else this.add("PP-09", sha, f.path, "個人情報が写っていないか確認し、PREPUSH_IMAGES_REVIEWED=1 を付けて push し直す");
      }
      // バイナリに埋め込まれた文字列 (.pyc の絶対パス、画像のメタデータなど)
      if (f.binary && size <= BINARY_SCAN_LIMIT) {
        const exempt = FIXTURE_PATH.test(f.path);
        for (const run of printableRuns(git(["cat-file", "blob", f.blob], { buffer: true }))) {
          this.scanLine(run, sha, `${f.path} (バイナリ内の文字列)`, { exempt });
        }
      }
    }
  }

  scanAddedLines(base, sha) {
    const diff = git(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--no-textconv", base, sha]);
    let file = null;
    let inHunk = false;
    let lineNo = 0;
    for (const l of diff.split("\n")) {
      if (l.startsWith("diff --git ")) { file = null; inHunk = false; continue; }
      if (!inHunk) {
        if (l.startsWith("+++ ")) file = l === "+++ /dev/null" ? null : l.slice(6).replace(/\t$/, "");
        else if (l.startsWith("@@")) { inHunk = true; lineNo = hunkStart(l); }
        continue;
      }
      if (l.startsWith("@@")) { lineNo = hunkStart(l); continue; }
      if (l.startsWith("+")) {
        if (file) this.scanLine(l.slice(1), sha, `${file}:${lineNo}`, { exempt: FIXTURE_PATH.test(file) });
        lineNo++;
      } else if (l.startsWith(" ")) lineNo++;
    }
  }
}

function hunkStart(header) {
  const m = header.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
  return m ? Number(m[1]) : 0;
}

function printableRuns(buf) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i] : 0;
    const printable = (b >= 0x20 && b <= 0x7e) || b === 0x09;
    if (printable && start < 0) start = i;
    else if (!printable && start >= 0) {
      if (i - start >= 6) runs.push(buf.toString("latin1", start, i));
      start = -1;
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// 秘密情報 (PP-06): gitleaks を Docker で動かす

function runGitleaks(checker, revArgsList, expectPatches) {
  if (process.env.PREPUSH_SKIP_GITLEAKS === "1") {
    checker.notes.push("PREPUSH_SKIP_GITLEAKS=1 のため、秘密情報の検査 (PP-06) を省きました");
    return;
  }
  const top = git(["rev-parse", "--show-toplevel"]).trim();
  const common = path.resolve(top, git(["rev-parse", "--git-common-dir"]).trim());
  // worktree では .git の実体が別の場所にあるので、同じ絶対パスで見せる
  const mounts = ["-v", `${top}:${top}:ro`];
  if (!common.startsWith(top + path.sep)) mounts.push("-v", `${common}:${common}:ro`);
  for (const revArgs of revArgsList) {
    const r = spawnSync(DOCKER, ["run", "--rm", ...mounts, GITLEAKS_IMAGE, "git", top,
      `--log-opts=${revArgs.join(" ")}`, "--redact", "--no-banner", "--exit-code", "99",
      "--report-format", "json", "--report-path", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
    const log = `${r.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    if (r.error || (r.status !== 0 && r.status !== 99)) {
      checker.add("PP-06", "-------", "gitleaks を実行できません",
        `${r.error ? r.error.message : log.trim().split("\n").pop()} — Docker を起動するか、一時的に省くなら PREPUSH_SKIP_GITLEAKS=1`);
      continue;
    }
    // 範囲の指定を誤ると gitleaks は「0 件走査・漏れなし」で成功してしまう
    const scanned = Number((log.match(/(\d+) commits scanned/) || [])[1] || 0);
    if (expectPatches && scanned === 0) {
      checker.add("PP-06", "-------", "gitleaks がコミットを読めていません", `log-opts=${revArgs.join(" ")} — PREPUSH_SKIP_GITLEAKS=1 で省けます`);
      continue;
    }
    if (r.status === 99) {
      for (const f of JSON.parse(r.stdout || "[]")) {
        checker.add("PP-06", f.Commit, `${f.File}:${f.StartLine}`, `${f.RuleID} (値は伏せています)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------

function main(argv) {
  let updates;
  if (argv[0] === "--range" && argv[1]) updates = [[argv[1]]];
  else if (argv[0] === "--hook" && argv[1]) updates = updatesFromHook(argv[1], fs.readFileSync(0, "utf8"));
  else {
    console.error("usage: prepush-check.mjs --range <A..B> | --hook <remote> [<url>]");
    return 2;
  }
  const checker = new Checker();
  const seen = new Set();
  const commits = [];
  for (const revArgs of updates) for (const c of revList(revArgs)) if (!seen.has(c)) { seen.add(c); commits.push(c); }
  if (!commits.length) {
    console.log("push 前チェック: 新しいコミットはありません");
    return 0;
  }
  let withPatches = 0;
  for (const c of commits) if (checker.checkCommit(c)) withPatches++;
  runGitleaks(checker, updates, withPatches > 0);

  console.log(`push 前チェック: ${commits.length} コミットを検査しました`);
  if (!checker.deny.pats.length) console.log(`  (個人の禁止語リストがありません: ${checker.deny.file})`);
  for (const n of checker.notes) console.log(`  ※ ${n}`);
  if (!checker.violations.length) {
    console.log("  問題は見つかりませんでした");
    return 0;
  }
  for (const v of checker.violations) {
    console.log(`✗ [${v.rule}] ${RULES[v.rule]} — ${v.sha} ${v.loc}`);
    if (v.excerpt) console.log(`    ${v.excerpt}`);
  }
  console.log(`\n違反 ${checker.violations.length} 件のため push を中止しました。`);
  console.log("直し方は docs/prepush-check.md を参照してください。");
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`push 前チェックの内部エラー: ${e.message}`);
  process.exitCode = 2;
}
