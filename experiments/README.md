# Experiments — moved out

このディレクトリは機械学習系のサブプロジェクトを置くための場所ですが、現状すべて別の非公開リポジトリに移しています。

| 旧 path | 内容 |
|---|---|
| `experiments/privacy-filter-ja/` | `openai/privacy-filter` の日本語 fine-tune レシピとデータジェネレータ |

## 移した理由

- ML 実験は Chrome 拡張 / FastAPI ゲートウェイとライフサイクルが異なる (学習ジョブ・データセット・モデル成果物の管理が独立)
- 依存スタックが独立 (transformers 5.x, torch, datasets など)
- 本リポのサイズ肥大を避ける

移管は `git filter-repo --subdirectory-filter experiments/privacy-filter-ja` で履歴を保持したまま行いました。
