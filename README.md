# Openachieve Agent

Openachieve Agent は、拡張可能なコーディングエージェント CLI とランタイムパッケージのセットです。プロジェクトで `oa` CLI をインストールし、TypeScript 拡張、スキル、プロンプトテンプレート、テーマ、Openachieve パッケージで機能を拡張できます。

## 主な機能

- **対話型コーディングエージェント** - 自然言語でコード編集、デバッグ、プロジェクトナビゲーション
- **マルチプロバイダー LLM サポート** - OpenAI、Anthropic、Google、AWS Bedrock など統一 API
- **サブエージェントシステム** - 並列・逐次実行する専門エージェントへの作業委譲
  - `/view-agent` で実行中のサブエージェントのライブ対話表示
  - `/agents` コマンドでエージェント一覧と詳細検査
  - 組み込みエージェントタイプ：scout（高速偵察）、planner（実装計画）、worker（実装作業）、reviewer（レビュー修正）、context-builder（要件引き継ぎ）、researcher（Web 調査）、oracle（意思決定支援）、delegate（汎用）
- **ターミナル UI** - ファイル補完、画像ペースト、複数行編集などリッチな対話インターフェース
- **拡張可能なアーキテクチャ** - TypeScript でカスタムスキル、プロンプトテンプレート、テーマ、拡張機能を追加

## パッケージ構成

| パッケージ | 説明 |
|---------|-------------|
| **[@openachieve/ai](packages/ai)** | 統一マルチプロバイダー LLM API（OpenAI、Anthropic、Google など） |
| **[@openachieve/agent-core](packages/agent)** | ツール呼び出しと状態管理を備えたエージェントランタイム |
| **[@openachieve/agent](packages/coding-agent)** | `oa` として公開される対話型コーディングエージェント CLI |
| **[@openachieve/tui](packages/tui)** | 差分レンダリング機能付きターミナル UI ライブラリ |

## インストール

Node.js 22.19.0 以降が必要です。

```bash
npm install -g --ignore-scripts @openachieve/agent
```

`--ignore-scripts` は依存関係のライフサイクルスクリプトを無効化します。Openachieve Agent は通常の npm インストールではインストールスクリプトを必要としません。

## 初回起動

作業したいプロジェクトディレクトリで `oa` を起動します：

```bash
cd /path/to/project
oa
```

リクエストを入力して Enter を押します。デフォルトでは、Openachieve Agent はモデルに 4 つのツールを提供します：`read`、`write`、`edit`、`bash`。

ワンショットプロンプトの場合：

```bash
oa -p "このコードベースを要約して"
cat README.md | oa -p "このテキストを要約して"
```

## クイックコマンドリファレンス

### 対話コマンド

| コマンド | 説明 |
|---------|-------------|
| `@ファイル名` | ファイル参照（`@` でファジー検索） |
| `!コマンド` | シェルコマンドを実行し出力をエージェントに送信 |
| `/model` | 使用可能なモデル間で切り替え |
| `/settings` | 思考レベル、テーマなどを設定 |
| `/session` | セッション情報、トークン、コストを表示 |
| `/export` | セッションを HTML にエクスポート |
| `/login` | サブスクリプションプロバイダーにログイン |
| `/resume` | 前回のセッションから再開 |
| `/new` | 新しいセッションを開始 |

### サブエージェントコマンド

専門エージェントに作業を委譲：

```bash
/agents                           # 利用可能なエージェントタイプの一覧
/agents scout                     # scout エージェントの設定を表示
/agents --scope=builtin           # 組み込みエージェントのみフィルター
/run scout "認証周りを分析"        # scout エージェントを実行
/view-agent                       # 実行中のサブエージェント一覧を表示
/view-agent <runId>               # 特定のサブエージェントのライブ対話を表示
/parallel worker "機能A" -> worker "機能B"  # 並列実行
```

**組み込みエージェントタイプ**：
- **scout**（高速偵察）- コードベースの迅速な調査と情報収集
- **planner**（実装計画）- 実装戦略の設計と計画立案
- **worker**（実装作業）- 実際のコード実装
- **reviewer**（レビュー修正）- コードレビューと修正提案
- **context-builder**（要件引き継ぎ）- 要件の整理と引き継ぎ
- **researcher**（Web 調査）- Web 検索と情報調査
- **oracle**（意思決定支援）- 技術的意思決定のアドバイス
- **delegate**（汎用）- 汎用的なタスク実行

実行コマンドに `--bg` を追加するとバックグラウンドで実行（例：`/run scout "認証を分析" --bg`）。`--fork` を追加すると現在のセッションコンテキストから分岐。

詳しくは [usage.md](packages/coding-agent/docs/usage.md) を参照してください。

## 認証

サブスクリプションプロバイダーの場合は `/login` を使用：

```text
/login
```

組み込みサブスクリプションログインには Claude Pro/Max、ChatGPT Plus/Pro (Codex)、GitHub Copilot が含まれます。

または `oa` 起動前に API キーを設定：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
oa
```

サポートされている全プロバイダーについては [packages/coding-agent/docs/providers.md](packages/coding-agent/docs/providers.md) を参照してください。

## ドキュメント

- [クイックスタート](packages/coding-agent/docs/quickstart.md) - インストール、認証、初回セッションの実行
- [Openachieve Agent の使い方](packages/coding-agent/docs/usage.md) - 対話モード、スラッシュコマンド、サブエージェントシステム、セッション、コンテキストファイル、CLI リファレンス
- [設定](packages/coding-agent/docs/settings.md) - グローバルおよびプロジェクト設定
- [Openachieve パッケージ](packages/coding-agent/docs/packages.md) - 共有拡張、スキル、プロンプト、テーマのインストール
- [コンテナ化](packages/coding-agent/docs/containerization.md) - より強力なセキュリティ境界のためのサンドボックス環境での実行
- [CONTRIBUTING.md](CONTRIBUTING.md) - 貢献ガイドライン
- [AGENTS.md](AGENTS.md) - 人間とエージェント向けのプロジェクト固有ルール

## パーミッションとコンテナ化

Openachieve Agent には、ファイルシステム、プロセス、ネットワーク、または認証情報アクセスを制限する組み込みパーミッションシステムは含まれていません。デフォルトでは、起動したユーザーとプロセスのパーミッションで実行されます。

より強力な境界が必要な場合は、Openachieve Agent をコンテナ化またはサンドボックス化してください。3 つのパターンについては [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) を参照してください：

- **OpenShell**：`oa` プロセス全体をポリシー制御されたサンドボックスで実行
- **Gondolin 拡張**：`oa` とプロバイダー認証をホストに保持しつつ、組み込みツールと `!` コマンドをローカル Linux マイクロ VM にルーティング
- **Plain Docker**：`oa` プロセス全体をローカルコンテナで実行してシンプルな分離を実現

## ソースからの開発

```bash
npm install --ignore-scripts  # ライフサイクルスクリプトなしですべての依存関係をインストール
npm run build                 # すべてのパッケージをビルド
npm run check                 # リント、フォーマット、型チェック
./test.sh                     # テストを実行（API キーなしでは LLM 依存テストをスキップ）
./oa-test.sh                  # ソースから oa を実行（任意のディレクトリから実行可能）
```

## サプライチェーン強化

npm 依存関係の変更をレビュー済みコード変更として扱います。

- 直接の外部依存関係は正確なバージョンに固定。内部ワークスペースパッケージはバージョン範囲のまま
- `.npmrc` は `save-exact=true` と `min-release-age=2` を設定し、npm 解決中の同日依存関係リリースを回避
- `package-lock.json` が依存関係の信頼できる情報源。プリコミットは `OPENACHIEVE_ALLOW_LOCKFILE_CHANGE=1` が設定されていない限り、誤ったロックファイルコミットをブロック
- `npm run check` は固定された直接依存関係、ネイティブ TypeScript インポート互換性、生成された coding-agent shrinkwrap を検証
- 公開される CLI パッケージには `packages/coding-agent/npm-shrinkwrap.json` が含まれ、ルートロックファイルから生成され、npm ユーザー向けに推移的依存関係を固定
- リリーススモークテストは `npm run release:local` を使用してビルド、パック、リリースタグ付け前にリポジトリ外で分離された npm および Bun インストールを作成
- ローカルリリースインストール、文書化された npm インストール、`oa update --self` はサポートされている場所で `--ignore-scripts` を使用
- CI は `npm ci --ignore-scripts` でインストールし、スケジュールされた GitHub ワークフローは `npm audit --omit=dev` と `npm audit signatures --omit=dev` を実行
- Shrinkwrap 生成には依存関係ライフサイクルスクリプトの明示的な許可リストがあり、新しいライフサイクルスクリプト依存関係はレビューされるまでチェックに失敗

## 最新リリース

**バージョン 0.79.4**（2026-06-08）

### 新機能
- `/view-agent` コマンドによる実行中サブエージェントのライブ対話表示
- セッションファイル（.jsonl）パーサーによるメッセージ、ツール呼び出し、thinking ブロックの抽出
- TUI 対話ビューアーコンポーネント（自動フォロー、手動スクロール、カラー表示）
- `/agents` コマンドでのエージェント一覧と詳細検査機能の強化

### 修正
- `packages/ai/src/models.ts` の TypeScript 型推論エラーを修正
- `TProvider extends KnownProvider` から `TProvider extends keyof typeof MODELS` への変更により、より厳密な型安全性を実現

詳細は [CHANGELOG.md](packages/coding-agent/CHANGELOG.md) を参照してください。

## ライセンス

MIT
