## 2026-04-11 マルチプロバイダ対応の追加調査

### Manus API

Manus Documentationの公開ページでは、Manus APIはRESTful APIとして説明されており、アプリケーションやワークフローからタスク起動、ファイル管理、結果受領をプログラムから実行できるとされている。単純なテキスト補完APIではなく、計画・情報収集・ツール利用・成果物返却を行うエージェントAPIとして位置づけられている。

### Claude API

AnthropicのClaude API Docsでは、OpenAI SDK compatibilityが提供されているが、これは比較・評価向けであり、本番長期運用の主経路としてはネイティブClaude API利用が推奨されている。互換レイヤには system/developer message の先頭結合、audio未対応、strict schema保証なしなどの制限があるため、マルチプロバイダ設計では互換レイヤに全面依存せず、プロバイダ別アダプタを用意する方が安全である。

