// tests/prepush/prepush-check.test.mjs — push 前チェック (scripts/prepush-check.mjs)
//
// 使い捨ての git リポジトリに実際のコミットを作り、検査スクリプトを
// 子プロセスとして走らせて終了コードと出力を確かめる。
//
// 「この端末」の利用者名とホームは、実在しない tester / /home/tester に
// 差し替える。検査対象の文字列をテスト側で固定するため。
//
// Run: node --test tests/prepush/*.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKER = path.join(ROOT, "scripts/prepush-check.mjs");
const NOREPLY = "12345+tester@users.noreply.github.com";
const ZERO = "0".repeat(40);
const FAKE_USER = "tester";
const FAKE_HOME = `/home/${FAKE_USER}`;
const GITLEAKS_IMAGE = "zricethezav/gitleaks:v8.30.1";

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// 利用者のグローバル設定 (署名・hooksPath など) に左右されないようにする
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-test-"));
  tmpDirs.push(dir);
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Tester");
  g("config", "user.email", NOREPLY);
  // ~/.config/git/ignore (Claude Code が .claude/settings.local.json を足す) も読ませない
  g("config", "core.excludesFile", "/dev/null");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  g("update-ref", "refs/remotes/origin/main", "HEAD"); // ここまでは push 済み
  const denylist = path.join(dir, ".git", "test-denylist");
  fs.writeFileSync(denylist, "# 個人の文字列 (テスト用)\nPrivate.Person@Example.org\n");
  const repo = {
    dir, g, denylist,
    base: g("rev-parse", "HEAD"),
    commit(files, { message = "change", authorEmail, committerEmail } = {}) {
      for (const [rel, content] of Object.entries(files)) {
        const p = path.join(dir, rel);
        if (content === null) { fs.rmSync(p); continue; }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
      g("add", "-A");
      const env = { ...GIT_ENV };
      if (authorEmail) env.GIT_AUTHOR_EMAIL = authorEmail;
      if (committerEmail) env.GIT_COMMITTER_EMAIL = committerEmail;
      execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env });
      return g("rev-parse", "HEAD");
    },
  };
  return repo;
}

function run(repo, args, { env = {}, input = "" } = {}) {
  const r = spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: repo.dir,
    input,
    encoding: "utf8",
    env: {
      ...GIT_ENV,
      HOME: FAKE_HOME,
      USER: FAKE_USER,
      LOGNAME: FAKE_USER,
      PREPUSH_SKIP_GITLEAKS: "1",
      PREPUSH_DENYLIST: repo.denylist,
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const pushed = (repo, env) => run(repo, ["--range", `${repo.base}..HEAD`], { env });

function assertRejected(r, rule) {
  assert.equal(r.code, 1, `exit ${r.code}\n${r.out}`);
  assert.match(r.out, new RegExp(`\\[${rule}\\]`), r.out);
}
function assertPassed(r) {
  assert.equal(r.code, 0, `exit ${r.code}\n${r.out}`);
}

// ---- 基本 -------------------------------------------------------------

test("T-01 a clean push passes", () => {
  const repo = makeRepo();
  repo.commit({ "src/app.js": "export const x = 1;\n" });
  assertPassed(pushed(repo));
});

// ---- PP-01 コミットの作者情報 -----------------------------------------

test("T-02 a personal author email is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "a.txt": "a\n" }, { authorEmail: "someone@example.org" });
  assertRejected(pushed(repo), "PP-01");
});

test("T-03 a personal committer email is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "a.txt": "a\n" }, { committerEmail: "someone@example.org" });
  assertRejected(pushed(repo), "PP-01");
});

// ---- PP-02 この端末に固有の情報 ---------------------------------------

test("T-04 the home directory in an added line is rejected with its location", () => {
  const repo = makeRepo();
  repo.commit({ "docs/setup.md": "line one\ncd /home/tester/workspace/app\n" });
  const r = pushed(repo);
  assertRejected(r, "PP-02");
  assert.match(r.out, /docs\/setup\.md:2/, r.out);
});

test("T-05 a Windows path with the user name is rejected regardless of case", () => {
  const repo = makeRepo();
  repo.commit({ "docs/win.md": "copy to c:\\users\\TESTER\\Desktop\n" });
  assertRejected(pushed(repo), "PP-02");
});

test("T-06 a WSL network path with the user name is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "docs/wsl.md": "load \\\\wsl.localhost\\Ubuntu\\home\\tester\\app\\dev\n" });
  assertRejected(pushed(repo), "PP-02");
});

test("T-07 the home directory in a commit message is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "a.txt": "a\n" }, { message: "fix build under /home/tester/src" });
  const r = pushed(repo);
  assertRejected(r, "PP-02");
  assert.match(r.out, /コミットメッセージ/, r.out);
});

test("T-08 this machine's host name is rejected", (t) => {
  const host = os.hostname();
  if (host.length < 5 || /^(localhost|ubuntu|debian|raspberrypi)$/i.test(host)) {
    t.skip(`host name "${host}" is too generic to check`);
    return;
  }
  const repo = makeRepo();
  repo.commit({ "notes.md": `built on ${host.toLowerCase()} today\n` });
  assertRejected(pushed(repo), "PP-02");
});

test("T-09 a Claude Code scratchpad path is rejected", () => {
  // このテスト自身が push 前チェックに引っかからないよう、パスは実行時に組み立てる
  const scratch = ["", "tmp", "claude-1000", "-x-", "scratchpad", "out.png"].join("/");
  const repo = makeRepo();
  repo.commit({ "notes.md": `see ${scratch}\n` });
  assertRejected(pushed(repo), "PP-02");
});

test("T-09b the home path encoded by Claude Code is rejected for a short user name", () => {
  // 5 文字未満の利用者名は単独では検査しないので、この形は専用の規則でしか捕まらない
  const repo = makeRepo();
  repo.commit({ "notes.md": "memory: ~/.claude/projects/-home-abc-workspace-app/memory\n" });
  assertRejected(pushed(repo, { USER: "abc", LOGNAME: "abc", HOME: "/home/abc" }), "PP-02");
});

test("T-10 a bare user name of five or more characters is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "notes.md": "reviewed by Tester\n" });
  assertRejected(pushed(repo), "PP-02");
});

test("T-11 a placeholder home path is not mistaken for this machine", () => {
  const repo = makeRepo();
  repo.commit({ "docs/setup.md": "cd /home/<user>/workspace\ncd /home/testers-group\n" });
  assertPassed(pushed(repo));
});

// ---- PP-03 個人の禁止語リスト -----------------------------------------

test("T-12 a deny-listed string is rejected even in a test fixture with an allow marker", () => {
  const repo = makeRepo();
  repo.commit({ "tests/fixture.json": '{"to": "private.person@example.org"} // prepush:allow\n' });
  assertRejected(pushed(repo), "PP-03");
});

test("T-13 a deny-listed string in a file name is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "docs/private.person@example.org.md": "x\n" });
  assertRejected(pushed(repo), "PP-03");
});

// ---- PP-04 個人のメールアドレス ---------------------------------------

test("T-14 a free-mail address outside the test folders is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "docs/contact.md": "mail: taro.yamada@gmail.com\n" });
  assertRejected(pushed(repo), "PP-04");
});

test("T-15 a free-mail address inside the test folders is allowed as a fixture", () => {
  const repo = makeRepo();
  repo.commit({ "tests/vectors/email.json": '{"input": "taro.yamada@gmail.com"}\n' });
  assertPassed(pushed(repo));
});

test("T-16 an inline allow marker lets a sample address through", () => {
  const repo = makeRepo();
  repo.commit({ "docs/contact.md": "例: taro.yamada@gmail.com <!-- prepush:allow -->\n" });
  assertPassed(pushed(repo));
});

// ---- PP-05 私的なネットワークの識別子 ---------------------------------

test("T-17 a Tailscale address is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "docs/net.md": "ssh pi@100.101.102.103\n" });
  assertRejected(pushed(repo), "PP-05");
});

test("T-18 a MagicDNS host name is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "docs/net.md": "open https://pi.tail1234.ts.net/\n" });
  assertRejected(pushed(repo), "PP-05");
});

test("T-19 an ordinary LAN example address is allowed", () => {
  const repo = makeRepo();
  repo.commit({ "docs/net.md": "例: http://192.168.0.10:11434\n" });
  assertPassed(pushed(repo));
});

// ---- PP-07 生成物・端末ローカルのファイル -----------------------------

for (const [id, file] of [
  ["T-20", "src/__pycache__/main.cpython-311.pyc"],
  ["T-21", "pii-guard-v1.5.0.zip"],
  ["T-22", "tests/integration/node_modules/a/index.js"],
  ["T-23", "config/.env"],
  ["T-24", ".claude/settings.local.json"],
  ["T-24b", "src/local_mask_mcp.egg-info/PKG-INFO"],
  ["T-24c", "data/admin_token"],
  ["T-24d", "config/api_token"],
  ["T-24e", "data/audit.jsonl"],
]) {
  test(`${id} a generated or local-only file is rejected: ${file}`, () => {
    const repo = makeRepo();
    repo.commit({ [file]: "x\n" });
    assertRejected(pushed(repo), "PP-07");
  });
}

test("T-25b a test vector named after a secret category is allowed", () => {
  const repo = makeRepo();
  repo.commit({ "tests/vectors/secret.json": '[{"input": "password=hunter22"}]\n' });
  assertPassed(pushed(repo));
});

test("T-25 an example environment file is allowed", () => {
  const repo = makeRepo();
  repo.commit({ "config/.env.example": "API_URL=http://localhost\n" });
  assertPassed(pushed(repo));
});

// ---- PP-08 大きなファイル ---------------------------------------------

test("T-26 a file over 5 MiB is rejected", () => {
  const repo = makeRepo();
  repo.commit({ "data/blob.bin": Buffer.alloc(5 * 1024 * 1024 + 1) });
  assertRejected(pushed(repo), "PP-08");
});

test("T-27 a large file in the vendored runtime folder is allowed", () => {
  const repo = makeRepo();
  repo.commit({ "browser-extension/vendor/transformers/ort.wasm": Buffer.alloc(5 * 1024 * 1024 + 1) });
  assertPassed(pushed(repo));
});

// ---- PP-09 目視確認が必要な画像 ---------------------------------------

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(32)]);

test("T-28 an added image blocks the push until it is reviewed", () => {
  const repo = makeRepo();
  repo.commit({ "docs/shot.png": PNG });
  assertRejected(pushed(repo), "PP-09");
});

test("T-29 a reviewed image passes", () => {
  const repo = makeRepo();
  repo.commit({ "docs/shot.png": PNG });
  assertPassed(pushed(repo, { PREPUSH_IMAGES_REVIEWED: "1" }));
});

// ---- バイナリと履歴 ---------------------------------------------------

test("T-30 a home path embedded in a binary file is rejected", () => {
  const repo = makeRepo();
  const blob = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from("/home/tester/project/app.py"), Buffer.from([0, 0])]);
  repo.commit({ "build/app.bin": blob });
  assertRejected(pushed(repo), "PP-02");
});

test("T-31 a leak added and removed within the same push is still rejected", () => {
  const repo = makeRepo();
  repo.commit({ "notes.md": "cd /home/tester/app\n" });
  repo.commit({ "notes.md": "cd <your checkout>\n" });
  assertRejected(pushed(repo), "PP-02");
});

// ---- pre-push フックとしての動作 --------------------------------------

const hook = (repo, lines, env) => run(repo, ["--hook", "origin", "git@example.invalid:x.git"], { env, input: lines.join("\n") + "\n" });

test("T-32 commits already on the remote are not scanned again", () => {
  const repo = makeRepo();
  repo.commit({ "old.md": "cd /home/tester/app\n" });
  repo.g("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.g("switch", "-q", "-c", "feat");
  const tip = repo.commit({ "new.md": "clean\n" });
  assertPassed(hook(repo, [`refs/heads/feat ${tip} refs/heads/feat ${ZERO}`]));
});

test("T-33 a new branch is scanned for the commits the remote does not have", () => {
  const repo = makeRepo();
  repo.g("switch", "-q", "-c", "feat");
  const tip = repo.commit({ "new.md": "cd /home/tester/app\n" });
  assertRejected(hook(repo, [`refs/heads/feat ${tip} refs/heads/feat ${ZERO}`]), "PP-02");
});

test("T-34 an update scans the commits between the remote and local tips", () => {
  const repo = makeRepo();
  const tip = repo.commit({ "new.md": "cd /home/tester/app\n" });
  assertRejected(hook(repo, [`refs/heads/main ${tip} refs/heads/main ${repo.base}`]), "PP-02");
});

test("T-35 an unknown remote tip (force push) falls back to what the remote lacks", () => {
  const repo = makeRepo();
  const tip = repo.commit({ "new.md": "cd /home/tester/app\n" });
  assertRejected(hook(repo, [`refs/heads/main ${tip} refs/heads/main ${"1".repeat(40)}`]), "PP-02");
});

test("T-36 deleting a remote branch passes", () => {
  const repo = makeRepo();
  assertPassed(hook(repo, [`(delete) ${ZERO} refs/heads/old ${repo.base}`]));
});

// ---- PP-06 秘密情報 (gitleaks) ----------------------------------------

const gitleaksReady = spawnSync("docker", ["image", "inspect", GITLEAKS_IMAGE], { stdio: "ignore" }).status === 0;

test("T-37 gitleaks rejects a token", { skip: !gitleaksReady && `${GITLEAKS_IMAGE} is not available` }, () => {
  const repo = makeRepo();
  // リポジトリ自体に本物らしいトークンを置かないよう、実行時に組み立てる
  const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const body = [...crypto.randomBytes(36)].map((b) => alnum[b % alnum.length]).join("");
  repo.commit({ "config.txt": `token = ${"ghp_"}${body}\n` });
  assertRejected(pushed(repo, { PREPUSH_SKIP_GITLEAKS: "" }), "PP-06");
});

test("T-38 gitleaks passes a clean push", { skip: !gitleaksReady && `${GITLEAKS_IMAGE} is not available` }, () => {
  const repo = makeRepo();
  repo.commit({ "src/app.js": "export const x = 1;\n" });
  assertPassed(pushed(repo, { PREPUSH_SKIP_GITLEAKS: "" }));
});

test("T-39 the push is blocked when gitleaks cannot run", () => {
  const repo = makeRepo();
  repo.commit({ "src/app.js": "export const x = 1;\n" });
  const r = pushed(repo, { PREPUSH_SKIP_GITLEAKS: "", PREPUSH_DOCKER: "/nonexistent/docker" });
  assertRejected(r, "PP-06");
  assert.match(r.out, /PREPUSH_SKIP_GITLEAKS/, r.out);
});

test("T-40 a gitleaks run that read no commits blocks the push", () => {
  // 範囲の指定を誤ると、gitleaks は 0 件を走査して「漏れなし」で成功する。
  // その振る舞いを再現する偽の docker を使う。
  const repo = makeRepo();
  repo.commit({ "src/app.js": "export const x = 1;\n" });
  const fake = path.join(repo.dir, ".git", "fake-docker");
  fs.writeFileSync(fake, "#!/bin/sh\necho 'INF 0 commits scanned.' >&2\necho '[]'\nexit 0\n", { mode: 0o755 });
  const r = pushed(repo, { PREPUSH_SKIP_GITLEAKS: "", PREPUSH_DOCKER: fake });
  assertRejected(r, "PP-06");
});

test("T-41 gitleaks can read commits pushed from a linked worktree", { skip: !gitleaksReady && `${GITLEAKS_IMAGE} is not available` }, () => {
  // Claude Code は .claude/worktrees/ に worktree を作る。worktree の .git は
  // 本体の .git/worktrees/<名前> を指すファイルなので、そこも見える必要がある。
  const repo = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-wt-"));
  tmpDirs.push(outside);
  const wt = path.join(outside, "wt");
  repo.g("worktree", "add", "-q", "-b", "feat", wt);
  fs.writeFileSync(path.join(wt, "app.js"), "export const y = 2;\n");
  execFileSync("git", ["add", "-A"], { cwd: wt, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "wt change"], { cwd: wt, env: GIT_ENV });
  const r = spawnSync(process.execPath, [CHECKER, "--range", `${repo.base}..HEAD`], {
    cwd: wt, encoding: "utf8",
    env: { ...GIT_ENV, HOME: FAKE_HOME, USER: FAKE_USER, LOGNAME: FAKE_USER, PREPUSH_DENYLIST: repo.denylist },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

// ---- 実際の git push での動作 -----------------------------------------
//
// フックのラッパー (.githooks/pre-push) が検査スクリプトに stdin と引数を
// 渡し、終了コードをそのまま返しているかを、ローカルの bare リポジトリへの
// 本物の push で確かめる。

function makeRepoWithHook() {
  const repo = makeRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-remote-"));
  tmpDirs.push(remote);
  execFileSync("git", ["init", "-q", "--bare", remote], { env: GIT_ENV });
  for (const rel of [".githooks/pre-push", "scripts/prepush-check.mjs"]) {
    fs.mkdirSync(path.join(repo.dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(repo.dir, rel));
  }
  fs.chmodSync(path.join(repo.dir, ".githooks/pre-push"), 0o755);
  repo.commit({}, { message: "add the hook" });
  repo.g("config", "core.hooksPath", ".githooks");
  repo.g("remote", "add", "origin", remote);
  const push = () => spawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], {
    cwd: repo.dir, encoding: "utf8",
    env: { ...GIT_ENV, HOME: FAKE_HOME, USER: FAKE_USER, LOGNAME: FAKE_USER, PREPUSH_SKIP_GITLEAKS: "1", PREPUSH_DENYLIST: repo.denylist },
  });
  const remoteHead = () => spawnSync("git", ["rev-parse", "--verify", "-q", "refs/heads/main"], { cwd: remote, encoding: "utf8", env: GIT_ENV }).stdout.trim();
  return { repo, push, remoteHead };
}

test("T-42 the hook stops a real push that contains a leak", () => {
  const { repo, push, remoteHead } = makeRepoWithHook();
  repo.commit({ "notes.md": "cd /home/tester/app\n" });
  const r = push();
  assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /\[PP-02\]/);
  assert.equal(remoteHead(), "", "nothing may reach the remote");
});

test("T-43 the hook lets a clean push through", () => {
  const { repo, push, remoteHead } = makeRepoWithHook();
  const tip = repo.commit({ "notes.md": "clean\n" });
  const r = push();
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(remoteHead(), tip);
});
