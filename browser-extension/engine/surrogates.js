// engine/surrogates.js — deterministic type-preserving surrogate values.
//
// Instead of replacing detected PII with generic placeholders like
// "<PHONE_1>", these generators return fake values that preserve the
// shape of the original (IPs stay IP-shaped, emails stay email-shaped,
// etc.). This gives the upstream LLM more natural context to reason
// about than an empty placeholder token.
//
// Design rules (ported from zeroc00I/LLM-anonymization notes):
//   * **Same input → same surrogate** within a session (seeded hash).
//     We persist ``(label, original) → surrogate`` in a Map so two
//     references to the same entity always collapse to the same fake.
//   * **Type-preserving**: phone numbers stay in 0X0-XXXX-XXXX shape,
//     emails keep a local-part and domain, postal codes keep the
//     NNN-NNNN form, etc.
//   * **Non-routable / obviously fake**: IPs come from RFC 5737 TEST-NET
//     ranges, domains resolve to ``.pentest.local`` style, credit cards
//     use the 4111-1111-1111-1111 Visa test number.
"use strict";

(function attach(root) {
  // djb2 xor hash — 32-bit, deterministic, no crypto dependency.
  function hash32(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0);
  }

  function pick(list, seed) { return list[seed % list.length]; }

  const PERSON_FAKES = [
    "佐藤健太", "鈴木美咲", "高橋翔", "田村彩香", "伊藤雄介",
    "渡辺結衣", "山本大輝", "中村楓", "小林拓海", "加藤さくら",
    "John Doe", "Jane Smith", "Alex Kim", "Maria Garcia",
  ];
  const COMPANY_FAKES = [
    "株式会社サンプル商事", "合同会社テスト技研", "株式会社架空ホールディングス",
    "有限会社ダミー産業", "株式会社仮名コンサルティング",
  ];
  const LOCATION_FAKES = [
    "東京都千代田区丸の内1-1-1", "大阪府大阪市北区梅田2-2-2",
    "神奈川県横浜市西区みなとみらい3-3-3",
  ];

  // RFC 5737 TEST-NET ranges: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24.
  function fakeIpv4(seed) {
    const net = pick([[192, 0, 2], [198, 51, 100], [203, 0, 113]], seed);
    const host = ((seed >>> 8) % 254) + 1;
    return `${net[0]}.${net[1]}.${net[2]}.${host}`;
  }

  function fakePhoneJp(seed) {
    const prefix = pick(["070", "080", "090"], seed);
    const mid = String(((seed >>> 3) % 9000) + 1000);
    const tail = String(((seed >>> 12) % 9000) + 1000);
    return `${prefix}-${mid}-${tail}`;
  }

  function fakeEmail(seed, originalLocalLen) {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const localLen = Math.max(3, Math.min(originalLocalLen || 6, 10));
    let local = "";
    let s = seed;
    for (let i = 0; i < localLen; i++) {
      local += letters[s % 26];
      s = Math.floor(s / 26) + 7;
    }
    return `${local}@example.com`;
  }

  function fakePostalJp(seed) {
    const head = String(((seed >>> 0) % 900) + 100);
    const tail = String(((seed >>> 10) % 9000) + 1000);
    return `${head}-${tail}`;
  }

  function fakeHex(seed, length) {
    const chars = "0123456789abcdef";
    let s = seed >>> 0;
    let out = "";
    for (let i = 0; i < length; i++) {
      // xorshift32 — stays well-distributed across 32-bit state
      // unlike the earlier LCG that collapsed to zero in JS.
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      out += chars[s & 0x0f];
    }
    return out;
  }

  function fakeCreditCard() {
    // The canonical Visa test number. Always detected as "fake" by
    // payment processors so it cannot accidentally charge anyone.
    return "4111-1111-1111-1111";
  }

  function fakeMyNumber(seed) {
    const g = (n) => String(((seed >>> (n * 4)) % 9000) + 1000);
    return `${g(0)} ${g(1)} ${g(2)}`;
  }

  function fakeBankAccount(seed) {
    const kind = pick(["普通", "当座"], seed);
    const num = String(((seed >>> 3) % 9000000) + 1000000);
    return `${kind} ${num}`;
  }

  function fakePassport(seed) {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const l1 = letters[seed % 26];
    const l2 = letters[(seed >>> 5) % 26];
    const num = String(((seed >>> 10) % 9000000) + 1000000);
    return `${l1}${l2}${num}`;
  }

  function fakeCredential(seed) {
    return `[REDACTED_${fakeHex(seed, 6).toUpperCase()}]`;
  }

  const GENERATORS = {
    PERSON: (seed, orig) => pick(PERSON_FAKES, seed),
    PROPER_NOUN_PERSON: (seed, orig) => pick(PERSON_FAKES, seed),
    COMPANY: (seed, orig) => pick(COMPANY_FAKES, seed),
    ORGANIZATION: (seed, orig) => pick(COMPANY_FAKES, seed),
    PROPER_NOUN_ORG: (seed, orig) => pick(COMPANY_FAKES, seed),
    LOCATION: (seed, orig) => pick(LOCATION_FAKES, seed),
    ADDRESS: (seed, orig) => pick(LOCATION_FAKES, seed),
    PROPER_NOUN_LOCATION: (seed, orig) => pick(LOCATION_FAKES, seed),

    EMAIL_ADDRESS: (seed, orig) => {
      const at = (orig || "").indexOf("@");
      return fakeEmail(seed, at > 0 ? at : 6);
    },
    PHONE_NUMBER: (seed, orig) => fakePhoneJp(seed),
    PHONE_NUMBER_JP: (seed, orig) => fakePhoneJp(seed),
    POSTAL_CODE: (seed, orig) => fakePostalJp(seed),
    IP_ADDRESS: (seed, orig) => fakeIpv4(seed),

    MY_NUMBER: (seed, orig) => fakeMyNumber(seed),
    CREDIT_CARD: () => fakeCreditCard(),
    BANK_ACCOUNT: (seed, orig) => fakeBankAccount(seed),
    DRIVERS_LICENSE: (seed, orig) =>
      `${String((seed % 90) + 10)}-${String(((seed >>> 6) % 90) + 10)}-${String(((seed >>> 12) % 900000) + 100000)}-${String(((seed >>> 24) % 90) + 10)}`,
    PASSPORT: (seed, orig) => fakePassport(seed),

    API_KEY: (seed, orig) => `sk-${fakeHex(seed, 32)}`,
    SECRET: (seed, orig) => fakeHex(seed, 40),
    DB_CONNECTION: (seed, orig) =>
      `postgresql://user_${fakeHex(seed, 4)}:***@db.example.com:5432/app`,
    URL: (seed, orig) => `https://example.com/path/${fakeHex(seed, 6)}`,

    EMPLOYEE_ID: (seed, orig) => `EMP-${String(((seed >>> 0) % 90000) + 10000)}`,
    MEMBER_ID: (seed, orig) => `MEM-${String(((seed >>> 0) % 900000) + 100000)}`,
    CUSTOMER_ID: (seed, orig) => `CUST-${String(((seed >>> 0) % 90000) + 10000)}`,
    CONTRACT_NUMBER: (seed, orig) => `CT-${String(((seed >>> 0) % 900000) + 100000)}`,
    PURCHASE_ORDER: (seed, orig) => `PO-${String(((seed >>> 0) % 9000000) + 1000000)}`,
    INVOICE_NUMBER: (seed, orig) => `INV-${String(((seed >>> 0) % 900000) + 100000)}`,
    PATIENT_ID: (seed, orig) => `PAT-${String(((seed >>> 0) % 90000) + 10000)}`,
    SKU: (seed, orig) => `SKU-${fakeHex(seed, 6).toUpperCase()}`,

    MONETARY_AMOUNT: (seed, orig) =>
      `¥${(((seed >>> 0) % 999000) + 1000).toLocaleString()}`,
    ANNUAL_INCOME: (seed, orig) =>
      `年収${(((seed >>> 0) % 1500) + 300)}万円`,
    AGE: (seed, orig) => `${(((seed >>> 0) % 60) + 20)}歳`,
    DATE: (seed, orig) => {
      const y = 2020 + ((seed >>> 0) % 6);
      const m = ((seed >>> 6) % 12) + 1;
      const d = ((seed >>> 10) % 28) + 1;
      return `${y}/${m}/${d}`;
    },
  };

  // Cache so a repeated (label, original) pair returns the same
  // surrogate across a single page session.
  const cache = new Map();

  function surrogateFor(label, original) {
    if (!label || typeof original !== "string" || !original) return null;
    const cacheKey = `${label}\x00${original}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const seed = hash32(cacheKey);
    const gen = GENERATORS[label];
    if (!gen) {
      // Unknown label — fall back to a compact fake label reference.
      const fallback = `[${label}_${fakeHex(seed, 4).toUpperCase()}]`;
      cache.set(cacheKey, fallback);
      return fallback;
    }
    const value = gen(seed, original);
    cache.set(cacheKey, value);
    return value;
  }

  function clearCache() { cache.clear(); }

  const api = { surrogateFor, clearCache, GENERATORS };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { surrogates: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
