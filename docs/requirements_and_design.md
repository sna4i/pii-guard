# ローカルPIIマスキングMCPサービス 要件定義・基本設計

**対象**: フロント＋バックエンド  
**対象範囲の前提**: 本設計は、ローカルPC上で動作する軽量なフィルタリングサービスを中核とし、MCP対応クライアントおよび複数の生成AIサービスへ接続するHTTPクライアントの双方から利用できる構成を対象とする。OpenAI、Claude、Manus、および将来追加される他プロバイダへ切替可能な送信境界層を提供し、Web版ChatGPTや各種SaaS画面そのものを透過的に書き換える方式は本スコープ外とする。制御対象は、PC上のアプリケーション、自作クライアント、エージェント実行環境からの送信経路である。

## 1. 要件定義

### 1.1 概要

生成AIへの入力に個人情報や機微情報が含まれることが問題視される状況では、送信前にローカル環境で情報を削除・置換・匿名化できる境界層が必要である。MCPは、LLMアプリケーションと外部ツール・データソースを接続するための標準化されたプロトコルであり、ツールやリソースを明示的に提供できるため、**ローカルマスキング機能をMCPサーバとして提供しつつ、必要に応じて複数プロバイダ向けHTTPプロキシとしても利用できる構成**は合理的である[1]。また、Presidioはテキストと画像に対するPII識別・匿名化、さらにOCRを伴う画像のPII redactionを提供しており、ローカル匿名化基盤の中核候補として適している[2]。AnthropicはOpenAI SDK互換レイヤを提供しているが、これは主に比較・評価向けであり、本番ではネイティブClaude APIの利用が推奨されているため、互換レイヤに全面依存せず**プロバイダ別アダプタ**を持つ設計が望ましい[4]。さらに、ManusはRESTfulなManus APIを公開しており、単純な補完APIではなくタスク起動・ファイル管理・成果物取得を含むエージェントAPIとして扱う必要がある[5]。一方で、自動検出には限界があるため、完全自動化だけに依存せず、監査・設定・人手確認を前提とした設計が必要である[2]。

本システムの目的は、**PC → ローカルフィルタリング → 選択した生成AIサービス**という送信経路を実現し、ユーザーが軽量に導入でき、必要時に即時ON/OFF切替でき、かつOpenAI・Claude・Manus・その他プロバイダを運用時に切替可能なローカルサービスを提供することである。KPIは、送信前マスキング適用率100%、PII検出ルールの切替時間3秒以内、既定プロバイダ切替5秒以内、テキスト100KB以内の処理応答1秒以内、A4相当PDF 20ページ以内の前処理完了30秒以内を基準とする。

| 項目 | 定義 |
| --- | --- |
| 背景 | 生成AI利用時に個人情報が外部サービスへ送信されるリスクを低減したい |
| 目的 | ローカルでPIIを検出・マスクしてから外部AIへ送信する |
| 達成指標 | マスキング適用率100%、ON/OFF切替3秒以内、既定プロバイダ切替5秒以内、監査ログ100%記録 |
| 対象 | テキスト、PDF、画像、OCR対象画像、MCP対応クライアント、OpenAI/Claude/Manus/その他プロバイダ向けクライアント |
| 対象外 | Web版ChatGPTの既存ブラウザUIへの透過挿入、DLP製品レベルの全社統制 |

### 1.2 業務要件

現状のAs-Isでは、ユーザーやアプリケーションがそのまま生成AIへ入力を送信し、送信内容の中に氏名、住所、電話番号、メールアドレス、社員番号、契約番号、口座情報、スクリーンショット内テキストなどが含まれる可能性がある。To-Beでは、送信前に必ずローカルのフィルタリング層を通過し、ルールに応じてマスク済みテキストまたはマスク済みファイルへ変換したうえで外部AIへ送信する。

| 業務ID | As-Is | To-Be |
| --- | --- | --- |
| B-001 | ユーザーが生成AIへ直接入力送信する | ローカル境界層を経由して送信する |
| B-002 | PDFや画像の添付前に内容確認が属人化している | ローカルでOCR・PII検出・マスクを自動実行する |
| B-003 | どの情報を外部送信したか追跡できない | 監査ログで検出件数・送信先・ON/OFF状態を記録する |
| B-004 | 必要に応じた例外運用が困難 | ON/OFF切替、対象エンティティ指定、バイパス承認を提供する |

業務フローは、ユーザーが送信対象を選択し、ローカルサービスに入力を渡し、サービスがタイプ判定、抽出、PII検出、匿名化、監査記録を行い、その結果を外部AIサービスへ送信する時系列で定義する。業務ルールとして、原文はローカル外へ送信しないこと、マスクOFF時にも監査ログを残すこと、設定変更は管理権限者のみが行えること、ファイル処理失敗時は送信を止めることを必須とする。

### 1.3 機能要件

| 機能ID | 機能名 | 機能概要 |
| --- | --- | --- |
| F-001 | フィルタON/OFF切替 | ローカル設定により送信前マスキングを有効/無効化する |
| F-002 | テキストPII検出 | テキスト入力からPIIを検出する |
| F-003 | テキスト匿名化 | 検出したPIIをタグ置換またはハッシュ化する |
| F-004 | PDF解析 | PDFからテキスト抽出し、必要に応じてOCRを実施する |
| F-005 | 画像OCR解析 | 画像からOCRでテキスト抽出しPII検出する |
| F-006 | ファイル再生成 | マスク済みPDF/画像/プレーンテキストを出力する |
| F-007 | 外部AIプロキシ送信 | マスク済みデータを選択した外部AI APIへ転送する |
| F-008 | MCPツール提供 | sanitize_text, sanitize_file, toggle_filter, set_provider等をMCPで提供する |
| F-009 | 監査ログ記録 | 検出件数、対象種別、送信先、処理結果をローカル保存する |
| F-010 | ルール設定管理 | 検出対象エンティティ、置換方式、バイパス条件、プロバイダ設定を変更する |
| F-011 | プレビュー確認 | 送信前にマスク結果のサマリを確認できる |
| F-012 | フェイルクローズ制御 | 解析失敗時は外部送信を停止する |
| F-013 | プロバイダ切替 | 既定プロバイダやリクエスト単位の送信先を切替する |
| F-014 | プロバイダ別正規化 | OpenAI/Claude/Manus/Generic の要求・応答差分を吸収する |

各機能の詳細は、入力・処理・出力の観点で次表のとおり定義する。

| 機能ID | 入力 | 処理 | 出力 |
| --- | --- | --- | --- |
| F-001 | 管理画面操作またはMCP呼び出し | 実行時設定の切替と永続化 | 現在状態ON/OFF |
| F-002 | 文字列、会話履歴、抽出済みテキスト | Recognizer適用、ルール評価 | 検出エンティティ一覧 |
| F-003 | 検出エンティティ一覧、匿名化ポリシー | タグ置換、部分マスク、トークン化 | マスク済みテキスト |
| F-004 | PDFファイル | 文字抽出、画像ページ判定、OCR | 抽出テキスト、ページ別メタデータ |
| F-005 | PNG/JPEG等 | OCR、座標付きPII抽出 | 画像上のPII領域一覧 |
| F-006 | 原文ファイル、PII領域 | テキスト置換または矩形塗りつぶし | マスク済みファイル |
| F-007 | 外部AI向けリクエスト | 必要に応じてF-002〜F-006実行後に選択プロバイダへ転送 | 外部AIレスポンス |
| F-008 | MCPリクエスト | ツール引数検証、内部サービス呼び出し | サニタイズ結果または状態更新結果 |
| F-009 | 処理コンテキスト | JSON Lines監査記録 | ローカルログ |
| F-010 | 設定変更要求 | スキーマ検証、反映 | 最新設定 |
| F-011 | 送信前内容 | 検出件数サマリ生成 | プレビュー結果 |
| F-012 | 例外/失敗 | エラー分類、外部送信遮断 | 失敗応答、監査ログ |
| F-013 | provider_id / request override | 既定値解決、許可対象確認 | 実際の転送先プロバイダ |
| F-014 | プロバイダ固有ペイロード | 正規化、ヘッダ付与、レスポンス変換 | 標準化済み転送結果 |

### 1.4 非機能要件

本システムはローカル常駐を前提とするため、性能要件と軽量性の両立が重要である。FastAPIのような軽量HTTPサーバとローカルJSON設定、ローカルファイル監査ログを用いることで、導入負荷を抑える。セキュリティ面では、MCP仕様がユーザー同意とデータプライバシーを重視していることを踏まえ、外部送信前に必ずレビュー可能な設計とし、MCPサーバおよびHTTPプロキシはlocalhostバインドを原則とする[1]。また、OpenAI APIではAPI送信データは既定で学習に使用されない一方、エンドポイントや設定に応じてログ・アプリケーション状態として保持され得るため、**送る前にローカルで除去する**方針は依然として有効である[3]。Claude互換レイヤには互換上の制限があるため、同一のOpenAI互換ペイロードを全プロバイダにそのまま流す方式ではなく、**共通内部DTO → プロバイダ別アダプタ変換**を非機能要件として採用する[4]。

| 区分 | 要件ID | 要件内容 |
| --- | --- | --- |
| 性能 | NFR-001 | テキスト100KB以内は1秒以内でマスク処理完了 |
| 性能 | NFR-002 | 20ページPDFは30秒以内で抽出・マスク前処理完了 |
| 可用性 | NFR-003 | ローカル再起動後に自動復旧可能 |
| 可用性 | NFR-004 | 外部AI接続失敗時もマスク結果はローカル保持可能 |
| セキュリティ | NFR-005 | 外部送信前の原文保持はローカル限定 |
| セキュリティ | NFR-006 | localhost以外からの管理操作を拒否 |
| ログ/監視 | NFR-007 | すべての送信要求に監査IDを付与 |
| ログ/監視 | NFR-008 | エラー、検出件数、処理時間を記録 |
| バックアップ | NFR-009 | 設定ファイルと監査ログを日次退避可能 |
| 拡張性 | NFR-010 | Recognizer追加時に既存API互換を維持 |
| 拡張性 | NFR-011 | プロバイダ追加時に共通API契約を維持しアダプタ差替のみで対応可能 |
| 運用性 | NFR-012 | 既定プロバイダを再起動なしで切替可能 |

### 1.5 UI要件

本サービスは軽量性を優先するため、UIは**最小管理UI**に限定する。最小構成として、ローカルWeb UIまたはCLIを用意し、ON/OFF切替、対象エンティティ設定、プレビュー確認、監査ログ参照を行う。通常運用ではMCPツールまたはHTTP APIを通じて利用し、UIは管理補助として扱う。

| 画面ID | 画面名 | 主目的 |
| --- | --- | --- |
| SCR-001 | ダッシュボード | 現在のON/OFF状態、最近の処理件数を確認 |
| SCR-002 | 設定画面 | 検出対象、匿名化方式、送信先設定を変更 |
| SCR-003 | プレビュー画面 | 送信前のマスク結果サマリを確認 |
| SCR-004 | 監査ログ画面 | 監査履歴を検索・確認 |

| 画面ID | 入力項目 | バリデーション | イベント/遷移 |
| --- | --- | --- | --- |
| SCR-001 | filter_enabled | 真偽値必須 | 保存で状態更新 |
| SCR-002 | entity_types | 1件以上必須 | 保存で設定反映 |
| SCR-002 | mask_strategy | enum必須 | 保存で設定反映 |
| SCR-003 | sample_text/sample_file | いずれか必須 | 実行でプレビュー生成 |
| SCR-004 | audit_id/date range | 任意、形式検証 | 検索で一覧表示 |

### 1.6 API要件

ローカルHTTP APIは、OpenAI互換プロキシ系と管理系に分ける。MCP利用時は別途MCP Server Interfaceを介して内部サービスを呼び出す。

| API ID | Method | Endpoint | 用途 | 認証 |
| --- | --- | --- | --- | --- |
| API-001 | GET | `/health` | ヘルスチェック | 不要（localhost限定） |
| API-002 | GET | `/admin/config` | 現在設定取得 | ローカル管理トークン |
| API-003 | PUT | `/admin/config` | 設定更新 | ローカル管理トークン |
| API-004 | POST | `/admin/toggle` | ON/OFF切替 | ローカル管理トークン |
| API-005 | POST | `/sanitize/text` | テキスト単体マスク | ローカル管理トークン |
| API-006 | POST | `/sanitize/file` | ファイル単体マスク | ローカル管理トークン |
| API-007 | POST | `/proxy/openai/v1/chat/completions` | OpenAI系チャット転送 | アップストリームAPIキー |
| API-008 | POST | `/proxy/openai/v1/responses` | OpenAI系Responses転送 | アップストリームAPIキー |
| API-009 | POST | `/proxy/anthropic/v1/messages` | Claude Messages転送 | アップストリームAPIキー |
| API-010 | POST | `/proxy/manus/v1/tasks` | Manus APIタスク起動転送 | アップストリームAPIキー |
| API-011 | POST | `/proxy/generic/{provider_id}` | Generic Provider転送 | アップストリームAPIキー |
| API-012 | GET | `/admin/audits` | 監査ログ一覧 | ローカル管理トークン |

### 1.7 データ要件

永続データは軽量性を優先し、初期実装ではローカルJSON/YAML設定とJSON Lines監査ログを採用する。将来的にSQLiteへ置換可能なRepository抽象を用意する。

| エンティティ | カラム | 型 | 制約 |
| --- | --- | --- | --- |
| config | filter_enabled | boolean | 必須 |
| config | entity_types | array[string] | 1件以上 |
| config | mask_strategy | string | `tag` / `partial` / `hash` |
| config | fail_closed | boolean | 必須 |
| config | default_provider_id | string | `openai` / `anthropic` / `manus` / `custom-*` |
| config | providers | object | provider_idごとの接続設定を保持 |
| config | created_at / updated_at | datetime | ISO8601 |
| provider_config | provider_id | string | 一意 |
| provider_config | provider_type | string | `openai` / `anthropic` / `manus` / `generic` |
| provider_config | base_url | string | URL形式 |
| provider_config | api_key_env | string | 環境変数名 |
| provider_config | enabled | boolean | 必須 |
| provider_config | route_mode | string | `native` / `openai_compat` |
| provider_config | model_mapping | object | 任意 |
| audit_log | audit_id | string | 一意 |
| audit_log | request_type | string | `text` / `pdf` / `image` / `proxy` |
| audit_log | filter_enabled | boolean | 必須 |
| audit_log | detected_count | integer | 0以上 |
| audit_log | entity_summary | object | 任意 |
| audit_log | upstream_target | string | 任意 |
| audit_log | status | string | `success` / `blocked` / `error` |
| audit_log | elapsed_ms | integer | 0以上 |
| audit_log | created_at | datetime | ISO8601 |

### 1.8 業務ロジック

マスキング判定ロジックは、まずリクエスト種別を `text` `pdf` `image` `mixed` に分類し、`filter_enabled=false` の場合は監査ログのみ記録して素通しする。`filter_enabled=true` の場合はテキスト系ならPII検出・匿名化、PDFならテキスト抽出後に不足ページのみOCR、画像ならOCRと座標ベースPII redactionを適用する。続いて `provider_resolver` がリクエスト単位 override と既定設定から送信先を確定し、`provider_adapter` が共通内部DTOを各プロバイダの要求形式へ変換する。検出結果が0件でも処理済みとして送信可能だが、解析失敗時は `fail_closed=true` なら外部送信を遮断する。状態遷移は `RECEIVED → EXTRACTING → DETECTING → MASKING → REVIEWABLE → NORMALIZING → FORWARDED` を基本とし、失敗時は `BLOCKED` または `ERROR` に遷移する。

| 状態 | 遷移条件 | 次状態 |
| --- | --- | --- |
| RECEIVED | 入力受付成功 | EXTRACTING |
| EXTRACTING | 抽出成功 | DETECTING |
| DETECTING | PII検出成功 | MASKING |
| MASKING | 匿名化成功 | REVIEWABLE |
| REVIEWABLE | プロバイダ解決と正規化成功 | NORMALIZING |
| NORMALIZING | 自動送信許可 | FORWARDED |
| 任意 | 解析失敗かつfail_closed=true | BLOCKED |
| 任意 | 予期せぬ例外 | ERROR |

### 1.9 権限

本サービスは単一PC内利用を前提とするが、運用上はロール分離を定義する。一般利用者は送信とプレビューのみを行い、管理者のみ設定変更と監査ログ閲覧を許可する。

| ロール | 権限 |
| --- | --- |
| R-001 User | サニタイズ実行、プロキシ送信、プレビュー参照 |
| R-002 Admin | User権限に加え、設定変更、ON/OFF切替、監査ログ閲覧 |

### 1.10 外部連携

| 連携ID | 連携先 | 通信方式 | 用途 |
| --- | --- | --- | --- |
| I-001 | OpenAI API | HTTPS | マスク後リクエスト送信 |
| I-002 | Anthropic Claude API | HTTPS | マスク後Messages送信 |
| I-003 | Manus API | HTTPS | マスク後タスク送信 |
| I-004 | MCP Host | stdioまたはstreamable transport | ツール提供 |
| I-005 | OCRエンジン | ローカルライブラリ/サブプロセス | 画像・PDF OCR |
| I-006 | Presidio Analyzer/Anonymizer | ローカルPython呼び出し | PII検出・匿名化 |

## 2. 基本設計 / 詳細設計

### 2.1 アーキテクチャ

推奨構成は、**ローカル軽量コアサービス + MCPインターフェース + マルチプロバイダHTTPプロキシ**の三層である。これにより、MCP対応クライアントは明示的に `sanitize_text` や `sanitize_file` を呼び出せる一方、既存のAPIクライアントは接続先URLをlocalhostへ向けるだけで導入できる。MCPはJSON-RPCベースでツール公開に向いており[1]、Presidioはローカル匿名化基盤としてテキスト・画像双方に対応する[2]。Anthropic互換レイヤは検証用途では有効だが本番の第一選択ではないため[4]、最も軽量かつ保守しやすい構成は、**必要最低限のFastAPI常駐プロセス1つに機能を集約し、その内部に共通DTOとプロバイダ別アダプタを実装し、MCPサーバは同じコアサービスを呼び出すアダプタとして実装する方式**である。

| レイヤ | コンポーネント | 役割 |
| --- | --- | --- |
| Client Layer | 自作CLI、MCP対応IDE、社内ツール | 入力送信元 |
| Control Layer | MCP Server Adapter | sanitize/toggle/auditツールを提供 |
| Edge Layer | Local HTTP Proxy | OpenAI/Claude/Manus/Generic APIを受けて上流へ転送 |
| Core Layer | Masking Service | 形式判定、PII検出、匿名化、プレビュー生成 |
| Adapter Layer | Provider Resolver / Provider Adapters | 共通DTOから各プロバイダ要求へ正規化 |
| Processing Layer | OCR/PDF/Image Service | PDF抽出、OCR、画像redaction |
| Persistence Layer | Config Repository / Audit Repository | 設定・監査ログ保存 |
| Upstream Layer | OpenAI / Anthropic / Manus / Others | マスク後データの送信先 |

> Presidioの公式ドキュメントは、テキストと画像のPII識別・匿名化、および画像に対するPII redactionモジュールを提供すると明記している[2]。

### 2.2 データフロー

1件の送信処理では、クライアントから受けた入力をまず `RequestClassifier` が判定し、テキスト・PDF・画像の処理系へ振り分ける。抽出済み文字列は `PiiDetectionService` に渡され、Presidio recognizer群とカスタム辞書で検出する。検出結果は `MaskingPolicy` に従い置換され、その後 `ProviderResolver` が送信先を選定し、`ProviderAdapter` が OpenAI / Anthropic / Manus / Generic の各要求形式へ変換する。必要に応じて `ProxyForwarder` が外部AIへ送信し、すべての処理は `AuditService` で追跡される。

| ステップ | 入力 | 処理 | 出力 |
| --- | --- | --- | --- |
| DF-001 | リクエスト | 種別判定 | text/pdf/image |
| DF-002 | text/pdf/image | 抽出/OCR | normalized_text or image boxes |
| DF-003 | normalized_text | PII検出 | entities |
| DF-004 | entities + policy | 匿名化 | sanitized_text / redacted_file |
| DF-005 | sanitized payload + provider context | 正規化 | provider specific payload |
| DF-006 | provider specific payload | 外部送信 | AI response |
| DF-007 | 全体コンテキスト | 監査記録 | audit log |

### 2.3 フロント設計

フロントは最小構成とし、技術的には静的HTMLまたは軽量SPAで十分である。主な責務は、現在状態の可視化、設定変更、プレビュー実行、監査ログ参照であり、業務ロジックはすべてバックエンドへ委譲する。状態管理は `config`, `previewResult`, `auditList` の3系統に分離し、すべてHTTP APIで取得・更新する。イベント処理は、ON/OFFトグル操作時に `POST /admin/toggle`、プレビュー時に `POST /sanitize/text` または `POST /sanitize/file` を呼び出す。

| コンポーネントID | コンポーネント | 責務 |
| --- | --- | --- |
| C-001 | StatusPanel | フィルタ状態表示・切替 |
| C-002 | EntityRuleForm | 対象エンティティ設定 |
| C-003 | PreviewForm | テキスト/ファイル入力とプレビュー |
| C-004 | AuditTable | 監査ログ一覧表示 |

### 2.4 バックエンド設計

バックエンドは `Controller → Service → Repository` に明確分離する。ControllerはHTTP/MCP入力の受け口のみを担当し、Serviceは処理順序と業務ルールを実装し、Repositoryは設定・監査ログの永続化を担当する。これにより、将来的にSQLiteやPostgreSQLへ移行する場合もService層の変更を最小化できる。

| 層 | クラス例 | 責務 |
| --- | --- | --- |
| Controller | ProxyController, AdminController | リクエスト受付、レスポンス整形 |
| Service | MaskingService, PdfService, OcrService, AuditService, ProviderRoutingService | 業務ロジック |
| Repository | ConfigRepository, AuditRepository | JSON/DBアクセス |
| Adapter | MCPToolAdapter, OpenAIAdapter, AnthropicAdapter, ManusAdapter, GenericAdapter | 外部接続抽象化 |

## 3. テスト設計

### 3.1 テスト方針

単体テストでは、PII検出ロジック、匿名化ポリシー、PDF抽出判定、設定Repository、監査ログ出力、プロバイダ解決、プロバイダ別ペイロード正規化を対象とする。結合テストでは、HTTPプロキシから各上流API転送までの一連動作、MCPツールからコアサービス呼び出し、OCR経由画像マスク処理を確認する。E2Eテストでは、ユーザーがUIまたはCLIから入力し、ON/OFF切替、プレビュー、送信、監査ログ参照、既定プロバイダ切替までを通して検証する。回帰テストでは、Recognizer追加や匿名化方式追加時だけでなく、プロバイダ追加時にも既存API契約を壊していないことを確認する。

### 3.2 テスト観点

| 観点分類 | 観点内容 |
| --- | --- |
| 正常系 | 想定入力で正しく検出・匿名化・送信できる |
| 異常系 | OCR失敗、PDF破損、上流API失敗時に遮断またはエラー応答となる |
| 入力観点 | 必須、型、拡張子、ファイルサイズ、フォーマットを検証する |
| 境界値 | 空文字、1文字、最大ページ数、最大ファイルサイズを検証する |
| 状態遷移 | ON/OFF切替、fail_closed動作、BLOCKED遷移を検証する |
| セキュリティ | XSS、認証バイパス、パストラバーサル、設定改ざん、SSRF、誤送信先プロバイダ選択を検証する |
| 互換性 | OpenAI/Claude/Manus/Generic間で正しい正規化が行われることを検証する |
| パフォーマンス | テキスト処理時間、PDF処理時間、同時接続時の遅延、プロバイダ切替時の遅延を測定する |

### 3.3 テストケース定義

| テストID | 対象機能ID | テスト観点 | 前提条件 | 入力データ | 操作手順 | 期待結果 | 実行結果 | 備考 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-001 | F-001 | 正常系 | 初期状態ON | `enabled=false` | `/admin/toggle`実行 | OFFへ切替、監査記録あり | 未実施 |  |
| T-002 | F-002 | 正常系 | フィルタON | `山田太郎の電話番号は09012345678` | `/sanitize/text`実行 | 氏名・電話番号が検出される | 未実施 |  |
| T-003 | F-003 | 境界値 | フィルタON | 空文字 | `/sanitize/text`実行 | 0件検出、空文字返却 | 未実施 |  |
| T-004 | F-004 | 正常系 | OCR利用可 | 文字入りPDF | `/sanitize/file`実行 | 抽出成功、マスク済みPDF生成 | 未実施 |  |
| T-005 | F-005 | 異常系 | OCR不可 | 破損画像 | `/sanitize/file`実行 | fail_closed=trueならBLOCKED | 未実施 |  |
| T-006 | F-007 | 正常系 | OpenAI上流API疎通可 | chat completion request | `/proxy/openai/v1/chat/completions`実行 | マスク済みプロンプトで転送 | 未実施 |  |
| T-007 | F-007 | 正常系 | Claude上流API疎通可 | messages request | `/proxy/anthropic/v1/messages`実行 | マスク済み入力で転送 | 未実施 |  |
| T-008 | F-007 | 正常系 | Manus上流API疎通可 | task request | `/proxy/manus/v1/tasks`実行 | マスク済み入力でタスク起動 | 未実施 |  |
| T-009 | F-008 | 正常系 | MCP host接続済み | `sanitize_text`引数 | MCP tool実行 | サニタイズ結果取得 | 未実施 |  |
| T-010 | F-009 | 正常系 | 任意 | 処理1件 | 任意API実行 | audit_idと検出件数が記録 | 未実施 |  |
| T-011 | F-010 | 異常系 | Admin token誤り | 不正トークン | `/admin/config`更新 | 401拒否 | 未実施 |  |
| T-012 | F-012 | 異常系 | fail_closed=true | OCRタイムアウト | プロキシ送信実行 | 外部送信されずBLOCKED | 未実施 |  |
| T-013 | F-013 | 正常系 | Provider設定済み | `provider_id=anthropic` | `/admin/config`またはMCPで切替 | 既定送信先がClaudeへ変更 | 未実施 |  |
| T-014 | F-014 | 正常系 | Provider設定済み | OpenAI形式入力 | Claude/Manusへ変換送信 | プロバイダ別に正規化成功 | 未実施 |  |

### 3.4 テストデータ

| データ区分 | 内容 |
| --- | --- |
| 正常データ | 氏名、電話番号、メールアドレス、住所、社員番号を含むテキスト |
| 異常データ | 破損PDF、破損画像、不正JSON、未知拡張子 |
| 境界値データ | 空文字、1ページPDF、20ページPDF、100KBテキスト、最大許容画像 |

### 3.5 自動化

単体テストは `pytest`、API結合テストは `httpx + pytest`、E2Eは `Playwright` またはCLI統合テストで実施する。CIでは `ruff`, `pytest`, 型チェックをpush時に実行し、mainマージ時にパッケージング成果物を生成する。

## 4. 開発運用

### 4.1 ブランチ戦略

| 区分 | ブランチ |
| --- | --- |
| 本番 | `main` |
| 開発統合 | `develop` |
| 機能開発 | `feature/*` |
| バグ修正 | `fix/*` |
| 緊急修正 | `hotfix/*` |

### 4.2 開発フロー

開発は `develop` から `feature/*` を作成し、実装とテストを完了後にPull Requestを作成する。レビューでは、要件ID・機能ID・テストIDのトレーサビリティが確認できることをマージ条件とする。リリース時は `develop` から `main` へマージし、`v1.0.0` 形式のタグを付与する。

### 4.3 コミット規約とCI/CD

| 項目 | ルール |
| --- | --- |
| コミット規約 | `feat:` `fix:` `refactor:` `test:` `docs:` |
| push時CI | Lint、Unit Test、Import Check |
| mainマージ時 | Release build、アーカイブ生成 |
| 配布物 | Python packageまたはローカル実行アーカイブ |

## 5. 運用・監視

運用監視はローカル用途のため過剰なAPMは不要だが、最低限のヘルスチェック、処理時間、検出件数、エラー件数、上流接続失敗回数は取得する。障害時は、設定破損、OCRエンジン異常、上流API認証失敗の3系統に分類し、復旧手順をRunbook化する。

| 項目 | 内容 |
| --- | --- |
| メトリクス | 処理件数、平均処理時間、BLOCKED件数、ERROR件数 |
| ログ | アクセスログ、監査ログ、例外ログ |
| 障害通知 | ローカル通知または標準出力警告 |
| 復旧手順 | 設定復元、OCR再初期化、上流キー再設定 |

## 6. セキュリティ

MCP仕様はユーザー同意・データプライバシー・ツール安全性を重要原則としているため[1]、本システムでもデフォルトをフェイルクローズに寄せる。管理APIはlocalhostバインドと管理トークンを必須とし、アップストリームAPIキーは環境変数でのみ保持する。ファイルアップロード時は拡張子とMIMEを二重検証し、保存先は作業ディレクトリ配下へ固定する。監査ログには原文を保存せず、必要に応じて件数サマリのみを記録する。

| セキュリティ要件ID | 内容 |
| --- | --- |
| SEC-001 | localhost以外からのアクセス拒否 |
| SEC-002 | 管理APIにBearerトークン適用 |
| SEC-003 | 原文は監査ログに保存しない |
| SEC-004 | ファイル処理失敗時は外部送信を遮断 |
| SEC-005 | 上流APIキーは環境変数またはOS秘密情報ストアに限定 |
| SEC-006 | 一時ファイルは処理完了後に削除 |

## 7. トレーサビリティ

| 要件ID | 機能ID | テストID |
| --- | --- | --- |
| NFR-005 | F-003, F-006, F-007 | T-002, T-004, T-006 |
| NFR-006 | F-001, F-010 | T-001, T-011 |
| NFR-007 | F-009 | T-010 |
| NFR-011 | F-013, F-014 | T-013, T-014 |
| SEC-004 | F-012 | T-005, T-012 |
| B-001 | F-007, F-008 | T-006, T-009 |
| B-002 | F-004, F-005, F-006 | T-004, T-005 |

## 8. 推奨実装方式の結論

最も軽量でON/OFF可能な方式は、**FastAPIベースのローカル常駐サービス1本**を中核にし、その上に **MCPアダプタ** と **マルチプロバイダHTTPプロキシ** を重ねる構成である。これにより、MCPを使うアプリケーションは明示的にサニタイズツールや送信先切替を呼び出せる一方、APIクライアントは接続先URLをlocalhostへ向けるだけで利用できる。実装上は `ProviderResolver + ProviderAdapter` パターンを採用し、OpenAI、Claude、Manus、その他プロバイダを同一コアから切替可能にする。PDFと画像はローカルOCRで処理し、PII検出・匿名化はPresidio中心に実装する。誤検知・漏検知に備え、監査ログとプレビューを併設し、fail-closedを既定値にすることで実運用に耐える。

## References

[1]: https://modelcontextprotocol.io/specification/2025-06-18 "Specification - Model Context Protocol"
[2]: https://microsoft.github.io/presidio/ "Home - Microsoft Presidio"
[3]: https://developers.openai.com/api/docs/guides/your-data "Data controls in the OpenAI platform"
[4]: https://platform.claude.com/docs/en/api/openai-sdk "OpenAI SDK compatibility - Claude API Docs"
[5]: https://manus.im/docs/integrations/manus-api "Manus API - Manus Documentation"
