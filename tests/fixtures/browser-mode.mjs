// tests/fixtures/browser-mode.mjs — E2E のブラウザを画面に出すかどうか
//
// 既定はヘッドレス (画面に窓を出さない)。拡張機能を読み込めるよう、Playwright の chromium
// チャンネル (新しいヘッドレス) を使う。古いヘッドレス (chromium_headless_shell) は拡張機能を読めない。
// 窓を見ながら調べたいときは PII_E2E_HEADED=1。
export function browserMode() {
  return { headless: process.env.PII_E2E_HEADED !== "1", channel: "chromium" };
}
