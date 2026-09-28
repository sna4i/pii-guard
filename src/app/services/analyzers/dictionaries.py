"""Static dictionary fallback for PII detection.

Mirrors ``browser-extension/engine/dictionaries.js`` — update both
files together. Enumerates common Japanese surnames, all 47
prefectures, the 20 designated cities, major country names (JP + EN),
and a curated set of Western first names. These are wired into the
regex analyzer preset chain as additional categories so detection
works even without Sudachi or Presidio enabled.
"""
from __future__ import annotations

import re
from typing import Final

# ---- JP surnames top 50 (multi-char only, unambiguous with common nouns) ----
# Source: 総務省「令和2年住民基本台帳人口」 frequency ranking.
# Single-char surnames (林/森/川) are excluded because they overlap
# with everyday common nouns and would false-positive heavily.
JP_SURNAMES: Final[list[str]] = [
    "佐藤", "鈴木", "高橋", "田中", "伊藤", "渡辺", "山本", "中村", "小林", "加藤",
    "吉田", "山田", "佐々木", "山口", "松本", "井上", "木村", "斎藤", "清水", "山崎",
    "阿部", "池田", "橋本", "山下", "石川", "中島", "前田", "藤田", "後藤", "近藤",
    "青木", "坂本", "遠藤", "福田", "太田", "西村", "藤井", "岡田", "三浦", "藤原",
    "中野", "岡本", "中川", "原田", "松田", "竹内", "金子", "和田", "石井", "長谷川",
]

# ---- All 47 Japanese prefectures ----
JP_PREFECTURES: Final[list[str]] = [
    "北海道",
    "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県",
    "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県",
    "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]

# ---- 20 designated cities (政令指定都市) ----
JP_DESIGNATED_CITIES: Final[list[str]] = [
    "札幌市", "仙台市", "さいたま市", "千葉市", "横浜市", "川崎市", "相模原市",
    "新潟市", "静岡市", "浜松市", "名古屋市", "京都市", "大阪市", "堺市",
    "神戸市", "岡山市", "広島市", "北九州市", "福岡市", "熊本市",
]

# ---- Major country names (JP + EN) ----
# G20 + major Asian countries. JP / EN notations are merged into one
# category since both are detected as ``WORLD_COUNTRY``.
WORLD_COUNTRIES_JP: Final[list[str]] = [
    "日本", "アメリカ", "米国", "中国", "韓国", "北朝鮮", "台湾", "香港",
    "ロシア", "イギリス", "英国", "フランス", "ドイツ", "イタリア", "スペイン",
    "カナダ", "メキシコ", "ブラジル", "アルゼンチン",
    "インド", "インドネシア", "タイ", "ベトナム", "フィリピン", "マレーシア", "シンガポール",
    "オーストラリア", "ニュージーランド",
    "サウジアラビア", "トルコ", "イスラエル", "エジプト", "南アフリカ",
]

WORLD_COUNTRIES_EN: Final[list[str]] = [
    "Japan", "USA", "America", "China", "Korea", "Taiwan", "Hong Kong",
    "Russia", "UK", "Britain", "England", "France", "Germany", "Italy", "Spain",
    "Canada", "Mexico", "Brazil", "Argentina",
    "India", "Indonesia", "Thailand", "Vietnam", "Philippines", "Malaysia", "Singapore",
    "Australia", "New Zealand",
    "Saudi Arabia", "Turkey", "Israel", "Egypt",
]

# ---- Western first names (business-common, no ambiguity) ----
# Excludes names that double as common nouns/acronyms (e.g. "Mike"
# could collide with microphone slang).
WESTERN_FIRST_NAMES: Final[list[str]] = [
    "John", "Michael", "David", "James", "Robert", "William", "Richard",
    "Thomas", "Charles", "Christopher", "Daniel", "Matthew", "Anthony",
    "Mary", "Jennifer", "Linda", "Elizabeth", "Patricia", "Barbara",
    "Susan", "Margaret", "Sarah", "Karen", "Lisa", "Nancy", "Emma",
]


def _from_list(items: list[str]) -> str:
    """Build a non-capturing alternation regex source (no anchors)."""
    return "(?:" + "|".join(re.escape(x) for x in items) + ")"


def _from_list_en(items: list[str]) -> str:
    """Like ``_from_list`` but with ASCII-only boundary assertions —
    keeps 'Japan' from matching inside 'Japanese' while still firing
    on 'Japan' sitting next to Japanese characters (where Python's
    Unicode ``\\b`` would fail because both sides are ``\\w``).
    Mirrors the JS engine's boundary so detection parity is exact."""
    return r"(?<![A-Za-z])" + _from_list(items) + r"(?![A-Za-z])"


#: Pattern sources (str) consumable by ``RegexAnalyzer`` or re.compile.
JP_SURNAME_PATTERN: Final[str] = _from_list(JP_SURNAMES)
JP_PREFECTURE_PATTERN: Final[str] = _from_list(JP_PREFECTURES)
JP_DESIGNATED_CITY_PATTERN: Final[str] = _from_list(JP_DESIGNATED_CITIES)
WORLD_COUNTRY_JP_PATTERN: Final[str] = _from_list(WORLD_COUNTRIES_JP)
WORLD_COUNTRY_EN_PATTERN: Final[str] = _from_list_en(WORLD_COUNTRIES_EN)
WESTERN_FIRST_NAME_PATTERN: Final[str] = _from_list_en(WESTERN_FIRST_NAMES)
