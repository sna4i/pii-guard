// Dashboard 操作用: store-session.sh で起動した Chrome に CDP で接続する。
// browser.close() は CDP 接続を切るだけで、ブラウザ自体は閉じない。
// ブラウザを閉じるのは store-session.sh stop の役目。
import { chromium } from "playwright";
export async function withPage(fn) {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("webstore")) || ctx.pages()[0] || (await ctx.newPage());
  try { return await fn(page, ctx); } finally { await browser.close(); }
}
