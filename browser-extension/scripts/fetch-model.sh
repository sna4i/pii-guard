#!/usr/bin/env bash
# 判定層 (F-ML-002) のモデルを拡張機能パッケージへ配置する。
#
# 配置先: browser-extension/model/jev-0.8b/
#   config.json          … model_type を "qwen3" に書き換える。vendored の
#                          transformers.js は qwen3 は知っているが qwen3_5_text を
#                          知らないため、書き換えないと AutoConfig で落ちる。
#   tokenizer.json       … そのまま
#   tokenizer_config.json… tokenizer_class=Qwen2Tokenizer を引くために必要
#   model.onnx           … onnx_int8/ の graph (external data を指す)
#   model.onnx_data      … 1.0 GB。git 追跡外 (.gitignore)。
#
# engine/decision-config.json (readout config: スロット token id と温度) も
# 同時に置く。温度表は本体と組でしか意味を持たないので、ずれたまま動かさない。
#
# 入力は experiments/jev-spike/onnx_int8 (T-ML-002 の成果物) と HF キャッシュ。
# どちらも無ければ export_test3.py を先に走らせる。
#
#   bash browser-extension/scripts/fetch-model.sh
set -euo pipefail

cd "$(dirname "$0")/.."
EXT="$PWD"
SPIKE="$EXT/../experiments/jev-spike"
HF="$HOME/.cache/huggingface/hub/models--chaoliangUNSW--Jev-Style-0.8B-Decision-v3/snapshots"
DEST="$EXT/model/jev-0.8b"

SNAP="$(ls -d "$HF"/*/ 2>/dev/null | head -1 || true)"
[ -n "$SNAP" ] || { echo "HF キャッシュが無い。export_test3.py でダウンロード済みか確認して" >&2; exit 1; }
[ -f "$SPIKE/onnx_int8/model.onnx_data" ] || { echo "onnx_int8 が無い: $SPIKE" >&2; exit 1; }

mkdir -p "$DEST"

python3 - "$SNAP/config.json" "$DEST/config.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
cfg = json.load(open(src))
cfg["model_type"] = "qwen3"          # qwen3_5_text -> qwen3 (arch map に合わせる)
cfg["architectures"] = ["Qwen3ForCausalLM"]
json.dump(cfg, open(dst, "w"), indent=2)
PY

cp -L "$SNAP/tokenizer.json" "$DEST/tokenizer.json"
cp -L "$SNAP/tokenizer_config.json" "$DEST/tokenizer_config.json"
cp "$SPIKE/onnx_int8/model.onnx" "$DEST/model.onnx"
cp "$SPIKE/onnx_int8/model.onnx_data" "$DEST/model.onnx_data"

# readout config はそのまま置いたうえで vocab_size を足す。JS 側は logits の
# 平坦な配列を「slot * vocab + token_id」で引くので、語彙数を config から
# 取れると取り違えに気づきやすい (graph の出力次元 248320 と一致する)。
python3 - "$SPIKE/readout_config.json" "$EXT/engine/decision-config.json" "$DEST/config.json" <<'PY'
import json, sys
src, dst, model_cfg = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(src))
vocab = json.load(open(model_cfg))["vocab_size"]
assert vocab > 0
cfg["vocab_size"] = vocab
json.dump(cfg, open(dst, "w"), indent=2, ensure_ascii=False)
PY

echo "✓ $DEST に配置した"
du -sh "$DEST"
