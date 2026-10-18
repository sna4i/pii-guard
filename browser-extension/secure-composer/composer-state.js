// secure-composer/composer-state.js — Secure Composer の状態機械 (純粋関数。Node でテストできる)。
//
// 状態 (spec 5):
//   INITIALIZING → SECURE_READY → EDITING → SUBMIT_REQUESTED → MASKING
//     → COMMIT_READY → SUBMITTING → SENT → SECURE_READY
//   どの状態からでも異常時は BLOCKED。MASKING_FAILED は編集へ戻す回復点。
//
// 不変条件 (threat-model INV-2):
//   - MASKING / SUBMITTING / COMMIT_READY の間は編集で割り込めない (競合防止)。
//   - マスク失敗は MASKING_FAILED (= 送信停止、下書き保持) にのみ遷移し、送信には進めない。
//   - BLOCKED は「保護できない」状態。ここから送信可能な状態へは遷移しない。
"use strict";

(function attach(root) {
  const S = Object.freeze({
    INITIALIZING: "INITIALIZING",
    SECURE_READY: "SECURE_READY",
    EDITING: "EDITING",
    SUBMIT_REQUESTED: "SUBMIT_REQUESTED",
    MASKING: "MASKING",
    MASKING_FAILED: "MASKING_FAILED",
    COMMIT_READY: "COMMIT_READY",
    SUBMITTING: "SUBMITTING",
    SENT: "SENT",
    BLOCKED: "BLOCKED",
  });

  // 許可する遷移。キー = 現在、値 = 遷移できる先。
  const NEXT = Object.freeze({
    INITIALIZING: [S.SECURE_READY, S.BLOCKED],
    SECURE_READY: [S.EDITING, S.BLOCKED],
    EDITING: [S.EDITING, S.SECURE_READY, S.SUBMIT_REQUESTED, S.BLOCKED],
    SUBMIT_REQUESTED: [S.MASKING, S.BLOCKED],
    MASKING: [S.COMMIT_READY, S.MASKING_FAILED, S.BLOCKED],
    MASKING_FAILED: [S.EDITING, S.BLOCKED],
    COMMIT_READY: [S.SUBMITTING, S.BLOCKED],
    SUBMITTING: [S.SENT, S.MASKING_FAILED, S.EDITING, S.BLOCKED],
    SENT: [S.SECURE_READY, S.EDITING, S.BLOCKED],
    BLOCKED: [S.INITIALIZING], // 回復は作り直し (INITIALIZING) からのみ
  });

  // この状態では編集中のテキストを変えてよいか (競合防止)。
  const EDIT_ALLOWED = Object.freeze({
    INITIALIZING: false, SECURE_READY: true, EDITING: true,
    SUBMIT_REQUESTED: false, MASKING: false, MASKING_FAILED: true,
    COMMIT_READY: false, SUBMITTING: false, SENT: true, BLOCKED: false,
  });

  function canTransition(from, to) {
    return Array.isArray(NEXT[from]) && NEXT[from].includes(to);
  }

  function create(initial) {
    let state = initial && S[initial] ? initial : S.INITIALIZING;
    const listeners = new Set();
    return {
      get() { return state; },
      is(...names) { return names.includes(state); },
      canEdit() { return EDIT_ALLOWED[state] === true; },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // 遷移できなければ false を返し、状態は変えない (呼び出し側が BLOCKED を選べる)。
      to(next, meta) {
        if (!canTransition(state, next)) return false;
        const prev = state;
        state = next;
        for (const fn of listeners) { try { fn(state, prev, meta || null); } catch (_) {} }
        return true;
      },
      // 異常系。常に BLOCKED へ落とす (INITIALIZING 以外のどこからでも)。
      block(reason) {
        const prev = state;
        if (state !== S.BLOCKED) {
          state = S.BLOCKED;
          for (const fn of listeners) { try { fn(state, prev, { reason: reason || "blocked" }); } catch (_) {} }
        }
        return state;
      },
    };
  }

  const api = { STATES: S, NEXT, canTransition, create };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__piiGuardSC = root.__piiGuardSC || {};
    root.__piiGuardSC.state = api;
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
