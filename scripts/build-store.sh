#!/usr/bin/env bash
# build-store.sh — produce a Chrome Web Store-ready dist/ from the
# shared browser-extension/ source tree.
#
# Pipeline:
#   1. Clean dist/browser-extension-store/ and dist/browser-extension-store.zip.
#   2. Copy browser-extension/ → dist/browser-extension-store/.
#   3. Overwrite manifest.json with manifest.store.json.
#   4. (v1.2.0: retained) LLM engine files (surrogates.js, llm-prompts.js)
#      now SHIP to the Store build. They are gated at runtime by
#      `optional_host_permissions: ["http://*/*"]`, so the Store install
#      itself never requests LAN host permission — users grant it from
#      the options page when they opt into local-LLM integration.
#   5. Strip `STORE-STRIP:START … STORE-STRIP:END` blocks from every
#      .js / .html file in the dist — see strip_markers() below.
#      The LLM blocks in content.js + options.html were unwrapped for
#      v1.2.0; the machinery stays here for any future dev-only blocks.
#   6. Validate the result:
#       - manifest.store.json not present (it's been inlined)
#       - no `http://*/*` in `host_permissions` (optional_host_permissions OK)
#       - no remaining STORE-STRIP markers
#       - LLM engine files present and referenced (flipped from v1.1.0)
#   7. Zip the dist/ for Web Store upload.
#
# Non-goals: minification, tree-shaking, source maps. The extension
# is already small and Chrome accepts readable source.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${REPO_ROOT}/browser-extension"
DIST="${REPO_ROOT}/dist/browser-extension-store"
ZIP="${REPO_ROOT}/dist/browser-extension-store.zip"

say() { printf "  %s\n" "$*"; }
fail() { printf "FAIL: %s\n" "$*" >&2; exit 1; }

# ---------- 1. Clean ----------
say "[1/7] cleaning previous dist"
rm -rf "$DIST" "$ZIP"
mkdir -p "$DIST"

# ---------- 2. Copy ----------
say "[2/7] copying source tree"
cp -r "$SRC/." "$DIST/"

# ---------- 3. Manifest swap ----------
say "[3/7] swapping manifest.json → manifest.store.json"
[ -f "$DIST/manifest.store.json" ] || fail "manifest.store.json missing in source"
mv "$DIST/manifest.store.json" "$DIST/manifest.json"

# ---------- 4. Retain LLM engine files (v1.2.0) ----------
# v1.0.x / v1.1.x deleted engine/llm-prompts.js + engine/surrogates.js here
# so no `http://*/*` LAN fetch path shipped to Store users. As of v1.2.0
# the Store variant ships LocalLLM too, gated by `optional_host_permissions`
# in manifest.store.json — the user must approve http://*/* at runtime
# from the options page before any LAN fetch can occur.
say "[4/7] retaining LLM engine files (gated by optional_host_permissions)"

# ---------- 5. Strip STORE-STRIP blocks ----------
#
# Marker convention:
#   JS:    // STORE-STRIP:START  …  // STORE-STRIP:END
#   HTML:  <!-- STORE-STRIP:START -->  …  <!-- STORE-STRIP:END -->
#
# A file that opens a block without closing it (or vice versa) is a
# bug — we fail rather than silently nuking code. This is critical
# since a rogue unbalanced marker could delete the whole file.
strip_markers() {
  local file="$1"
  local starts ends
  starts=$(grep -c "STORE-STRIP:START" "$file" || true)
  ends=$(grep -c "STORE-STRIP:END" "$file" || true)
  if [ "$starts" -ne "$ends" ]; then
    fail "unbalanced STORE-STRIP markers in $file (starts=$starts, ends=$ends)"
  fi
  [ "$starts" -eq 0 ] && return 0
  # sed -i '/START/,/END/d' — delete every line from START through END
  # inclusive. Works for both JS (// STORE-STRIP:…) and HTML (<!-- … -->)
  # because the marker substring is the same.
  sed -i '/STORE-STRIP:START/,/STORE-STRIP:END/d' "$file"
  say "    stripped $starts block(s) from ${file#$DIST/}"
}

say "[5/7] stripping STORE-STRIP blocks"
while IFS= read -r -d '' f; do
  strip_markers "$f"
done < <(find "$DIST" -type f \( -name "*.js" -o -name "*.html" \) -print0)

# ---------- 6. Validate ----------
say "[6/7] validating result"

# 6a. manifest must not grant http://*/* at install time. v1.2.0 allows
# `http://*/*` in `optional_host_permissions` (runtime-requested for
# LocalLLM), but it MUST NOT appear in `host_permissions`.
if command -v python3 >/dev/null; then
  python3 - "$DIST/manifest.json" <<'PY' || fail "Store manifest still grants http://*/* at install time — move it to optional_host_permissions"
import json, sys
m = json.load(open(sys.argv[1]))
hp = m.get("host_permissions", []) or []
if "http://*/*" in hp:
    sys.exit(1)
PY
fi

# 6b. no STORE-STRIP markers remain in code files. README and docs may
# mention the marker convention as prose — scan .js/.html/.json only.
leftover=$(find "$DIST" -type f \( -name "*.js" -o -name "*.html" -o -name "*.json" \) \
  -exec grep -l "STORE-STRIP:" {} + 2>/dev/null || true)
if [ -n "$leftover" ]; then
  fail "STORE-STRIP markers leaked through: $leftover"
fi

# 6c. dev-only manifest file was removed (moved)
if [ -f "$DIST/manifest.store.json" ]; then
  fail "manifest.store.json still present in dist"
fi

# 6d. LLM engine files are EXPECTED in v1.2.0+ Store build. Verify they
# exist on disk and are referenced from the manifest's
# web_accessible_resources (so content.js can inject them).
for expected in "engine/surrogates.js" "engine/llm-prompts.js"; do
  [ -f "$DIST/$expected" ] || fail "expected LLM engine file '$expected' missing from Store build"
  grep -q "$expected" "$DIST/manifest.json" \
    || fail "LLM engine file '$expected' not declared in manifest web_accessible_resources"
done

# 6e. manifest parses as valid JSON
if command -v python3 >/dev/null; then
  python3 -c "import json, sys; json.load(open('$DIST/manifest.json'))" \
    || fail "manifest.json is not valid JSON"
fi

# 6f. every JS file parses (node --check)
if command -v node >/dev/null; then
  while IFS= read -r -d '' f; do
    node --check "$f" >/dev/null 2>&1 \
      || fail "JS syntax error in ${f#$DIST/} after stripping"
  done < <(find "$DIST" -type f -name "*.js" -print0)
fi

# ---------- 7. Zip ----------
say "[7/7] creating zip for Web Store upload"
(cd "$DIST/.." && zip -qr "$(basename "$ZIP")" "$(basename "$DIST")")

size=$(du -h "$ZIP" | cut -f1)
file_count=$(find "$DIST" -type f | wc -l)
say ""
say "✅ Store build ready"
say "   dist:  $DIST"
say "   zip:   $ZIP  ($size, $file_count files)"
say "   Next:  upload zip to Chrome Web Store Developer Dashboard"
