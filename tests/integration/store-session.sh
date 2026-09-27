#!/usr/bin/env bash
# Chrome Web Store Dashboard を操作するための Chrome を起動/停止する。
#
#   bash tests/integration/store-session.sh start   # 起動 (CDP 9222)
#   bash tests/integration/store-session.sh stop    # 停止し、プロセスとポートの両方で確認
#   bash tests/integration/store-session.sh status
#
# Google は自動化フラグ付きのブラウザでのログインを拒否するので、
# 実物の Chrome を AutomationControlled 無効で起動する。初回と、
# セッションが切れたとき (おおむね 1 日) はユーザーのログインが必要。
#
# プロファイルは OS の一時領域に置く。Google のログイン Cookie を
# リポジトリや恒久的な場所に残さないため。
set -uo pipefail
PROFILE="${TMPDIR:-/tmp}/pii-guard-store-profile"
PORT=9222
URL="https://chrome.google.com/webstore/devconsole"

pids() { pgrep -f -- "--user-data-dir=$PROFILE" 2>/dev/null; }
port_up() { curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }

case "${1:-status}" in
  start)
    if port_up; then echo "既に起動中 (port $PORT)"; exit 0; fi
    mkdir -p "$PROFILE"
    setsid /opt/google/chrome/chrome --user-data-dir="$PROFILE" --remote-debugging-port=$PORT \
      --disable-blink-features=AutomationControlled "$URL" >/dev/null 2>&1 < /dev/null &
    disown
    for _ in $(seq 1 20); do port_up && break; sleep 1; done
    port_up && echo "起動しました (port $PORT)" || { echo "起動に失敗"; exit 1; }
    ;;
  stop)
    p="$(pids)"
    [ -n "$p" ] && kill -TERM $p 2>/dev/null
    sleep 4
    p="$(pids)"
    [ -n "$p" ] && kill -KILL $p 2>/dev/null && sleep 2
    if [ -z "$(pids)" ] && ! port_up; then echo "停止しました (プロセスなし / port $PORT 閉)"
    else echo "★ 停止できていません: $(pids)"; exit 1; fi
    ;;
  status)
    port_up && echo "起動中 (port $PORT)" || echo "停止中"
    ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
