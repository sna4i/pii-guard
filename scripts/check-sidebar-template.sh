#!/usr/bin/env bash
# Fails if any backtick sneaks inside the STYLE = `...` template
# literal in browser-extension/sidebar.js — a bug class that has
# crashed the extension three times running.
set -e
FILE=browser-extension/sidebar.js
OPEN=$(grep -n '^  const STYLE = `' "$FILE" | head -1 | cut -d: -f1)
CLOSE=$(grep -n '^  `;' "$FILE" | head -1 | cut -d: -f1)
if [ -z "$OPEN" ] || [ -z "$CLOSE" ]; then
  echo "could not locate STYLE template in $FILE" >&2
  exit 2
fi
INNER_START=$((OPEN + 1))
INNER_END=$((CLOSE - 1))
COUNT=$(sed -n "${INNER_START},${INNER_END}p" "$FILE" | grep -c '`' || true)
if [ "$COUNT" -ne 0 ]; then
  echo "FAIL: found $COUNT backtick(s) inside STYLE (lines $INNER_START..$INNER_END)" >&2
  echo "      these will terminate the template literal and crash sidebar.js" >&2
  sed -n "${INNER_START},${INNER_END}p" "$FILE" | grep -n '`' | sed "s/^/  relative line /" >&2
  exit 1
fi
echo "OK: STYLE template literal is clean ($INNER_END-$INNER_START lines scanned, 0 backticks)"
