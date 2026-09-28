// engine/dictionaries.js — 静的辞書ベースの fallback PII 検出層。
//
// 形態素解析 (Sudachi) + NER (Presidio) を有効にしていなくても、
// 日本の主要な姓・地名・海外の主要地名などを確実にマスク対象に
// するための curated リスト。regex で alternation を組み、既存の
// sweep-line overlap resolver に委ねる。長い span を持つ他カテゴリ
// (PREFECTURE_CITY, ADDRESS 等) がある場合はそちらが自動的に勝つ。
//
// 同じ内容を src/app/services/analyzers/dictionaries.py でミラー
// していること (CONTRIBUTING.md 参照)。
"use strict";

(function attach(root) {
  // ---- JP 苗字 top 50 (多字のみ、一般名詞と衝突しないもの) ----
  // 出典: 総務省「令和2年住民基本台帳人口」を元にした頻度順の上位。
  // 単字の姓 (林/森/川 等) は一般名詞として日常的に出現するので除外。
  const JP_SURNAMES = [
    "佐藤", "鈴木", "高橋", "田中", "伊藤", "渡辺", "山本", "中村", "小林", "加藤",
    "吉田", "山田", "佐々木", "山口", "松本", "井上", "木村", "斎藤", "清水", "山崎",
    "阿部", "池田", "橋本", "山下", "石川", "中島", "前田", "藤田", "後藤", "近藤",
    "青木", "坂本", "遠藤", "福田", "太田", "西村", "藤井", "岡田", "三浦", "藤原",
    "中野", "岡本", "中川", "原田", "松田", "竹内", "金子", "和田", "石井", "長谷川",
  ];

  // ---- 47 都道府県 ----
  const JP_PREFECTURES = [
    "北海道",
    "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県",
    "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県",
    "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
  ];

  // ---- 政令指定都市 20 ----
  // 2026 年時点の 20 都市 (札幌〜熊本)。東京 23 区は「区」単位なので別扱い。
  const JP_DESIGNATED_CITIES = [
    "札幌市", "仙台市", "さいたま市", "千葉市", "横浜市", "川崎市", "相模原市",
    "新潟市", "静岡市", "浜松市", "名古屋市", "京都市", "大阪市", "堺市",
    "神戸市", "岡山市", "広島市", "北九州市", "福岡市", "熊本市",
  ];

  // ---- 主要国名 (日本語 + 英語) ----
  // G20 + 主要アジア諸国。日英両表記を同一カテゴリで扱う。
  const WORLD_COUNTRIES_JP = [
    "日本", "アメリカ", "米国", "中国", "韓国", "北朝鮮", "台湾", "香港",
    "ロシア", "イギリス", "英国", "フランス", "ドイツ", "イタリア", "スペイン",
    "カナダ", "メキシコ", "ブラジル", "アルゼンチン",
    "インド", "インドネシア", "タイ", "ベトナム", "フィリピン", "マレーシア", "シンガポール",
    "オーストラリア", "ニュージーランド",
    "サウジアラビア", "トルコ", "イスラエル", "エジプト", "南アフリカ",
  ];
  const WORLD_COUNTRIES_EN = [
    "Japan", "USA", "America", "China", "Korea", "Taiwan", "Hong Kong",
    "Russia", "UK", "Britain", "England", "France", "Germany", "Italy", "Spain",
    "Canada", "Mexico", "Brazil", "Argentina",
    "India", "Indonesia", "Thailand", "Vietnam", "Philippines", "Malaysia", "Singapore",
    "Australia", "New Zealand",
    "Saudi Arabia", "Turkey", "Israel", "Egypt",
  ];

  // ---- Western first names (business-common、曖昧性なし) ----
  // 「apple」「mike」のような普通名詞/略語と衝突するものは避ける。
  const WESTERN_FIRST_NAMES = [
    "John", "Michael", "David", "James", "Robert", "William", "Richard",
    "Thomas", "Charles", "Christopher", "Daniel", "Matthew", "Anthony",
    "Mary", "Jennifer", "Linda", "Elizabeth", "Patricia", "Barbara",
    "Susan", "Margaret", "Sarah", "Karen", "Lisa", "Nancy", "Emma",
  ];

  // Regex 構築ヘルパー。CJK 文字列には word boundary が効かないので
  // そのまま alternation。英語は ASCII-only 境界を使う: `\b` は
  // Unicode モードで日本語にも反応してしまうことがあるため、
  // `(?<![A-Za-z])...(?![A-Za-z])` で「英字の前後に英字がない」を
  // 明示 (Python と JS で挙動を揃える目的)。
  const fromList = (list) => new RegExp(`(?:${list.map(escapeRe).join("|")})`, "gu");
  const fromListEn = (list) => new RegExp(`(?<![A-Za-z])(?:${list.map(escapeRe).join("|")})(?![A-Za-z])`, "gu");
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  const api = {
    JP_SURNAMES,
    JP_PREFECTURES,
    JP_DESIGNATED_CITIES,
    WORLD_COUNTRIES_JP,
    WORLD_COUNTRIES_EN,
    WESTERN_FIRST_NAMES,

    // Pre-compiled regex (pattern.js から import して使う)
    JP_SURNAME_RE: fromList(JP_SURNAMES),
    JP_PREFECTURE_RE: fromList(JP_PREFECTURES),
    JP_DESIGNATED_CITY_RE: fromList(JP_DESIGNATED_CITIES),
    WORLD_COUNTRY_JP_RE: fromList(WORLD_COUNTRIES_JP),
    WORLD_COUNTRY_EN_RE: fromListEn(WORLD_COUNTRIES_EN),
    WESTERN_FIRST_NAME_RE: fromListEn(WESTERN_FIRST_NAMES),
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { dictionaries: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
