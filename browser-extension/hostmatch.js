// hostmatch.js —  interception する provider かを URL 文字列の substring ではなく、
// 解析した hostname で決める (T-22)。
//
// 発端: commit security review (2026-11-24)。旧 SUPPORTED_HOST_RE は substring 照合で、
// "evilchatgpt.com" や path に "chatgpt.com" を含む URL (worker hook は URL 文字列全体を
// test していた) を trusted provider と扱っていた。設計線は README の掲載ドメインと同じ:
// exact host + subdomain root。
//
// consumer は injected.js (MAIN world)。content.js が injected.js より前に注入する
// (tests/engine/hostmatch.test.mjs T-22.5 が順を守る)。Node テストは module.exports 経由。
"use strict";

(function attach(root) {
  const HOSTS = new Set([
    "claude.ai",
    "claude.com",
    "chatgpt.com",
    "openai.com",
    "gemini.google.com",
    "manus.im",
    "butterfly-effect.dev",
  ]);

  function normalizeHost(host) {
    return String(host || "").toLowerCase().replace(/\.$/, "");
  }

  // exact host or subdomain root. "chatgpt.com.attacker.test" (suffix lookalike)
  // and path substrings do not match here — that was the review finding.
  function hostOk(host, domains) {
    const h = normalizeHost(host);
    return domains.some((base) => h === base || h.endsWith("." + base));
  }

  function isProviderHost(host) {
    return hostOk(host, [...HOSTS]);
  }

  function isProviderUrl(rawUrl, base) {
    return hostMatches(rawUrl, base, [...HOSTS]);
  }

  // adapter 選定用: その adapter 自分の domain ルートだけを見る (T-22.7)。
  // pickAdapter の gate (全 provider) の後ろで呼ばれる。
  function hostMatches(rawUrl, base, domains) {
    try {
      const u = new URL(rawUrl, base);
      // WHATWG parser は blob: URL の host を空にする。blob: は "blob:" の後の inner URL
      // の origin を見る (page JS が作る blob worker が old 版で捕まっていた挙動を保つ)。
      if (u.protocol === "blob:") return hostOk(new URL(u.href.slice(u.protocol.length)).hostname, domains);
      return hostOk(u.hostname, domains);
    } catch (_) {
      return false;
    }
  }

  // T-22.8 (security review, 2nd finding): the allowlist must not be reachable as
  // mutable state through the page-accessible global. MAIN world page code and this
  // API share the same world, so an exposed Set let a page add itself to the
  // trusted set and get the provider treatment (worker wrap, beacon refusal,
  // adapter match). Contract: allowlist stays in this closure; the exported API is
  // frozen, and callers only ever get a snapshot via listHosts().
  const api = Object.freeze({
    isProviderHost,
    isProviderUrl,
    hostMatches,
    listHosts: () => [...HOSTS],
  });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PiiGuardHostmatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
