// offscreen-quiet.js — offscreen 文書 (ML の判定) で、同梱の ML ライブラリ (transformers.js と
// onnxruntime) がコンソールに書く出力を止める。拡張機能はコンソールに何も書かない (docs/diagnostic-log.md の R-LG-01)。
// ライブラリはモジュールとして読み込まれるので、それより先に動くこの普通のスクリプトで差し替える
"use strict";
for (const k of ["log", "info", "warn", "error", "debug", "trace", "table", "dir"]) {
  try { console[k] = () => {}; } catch (_) { /* 何もしない */ }
}
