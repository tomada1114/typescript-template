# 汎用 TypeScript/npm パッケージテンプレート要件

この文書群は、`zukai` を実装する前に別リポジトリとして作る、汎用的な TypeScript/npm パッケージテンプレートの要件です。

`zukai` の仕様をテンプレートへ埋め込むことはしません。先にテンプレート単体の品質を完成させ、そのテンプレートから `zukai` リポジトリを生成して、図解ツール固有の実装へ進みます。

```
uv-template の知見
  ↓ 言語・配布先に合わせて翻訳
汎用 TypeScript/npm パッケージテンプレート
  ↓ bootstrap
zukai リポジトリ
  ↓
図解ツール固有の Phase 0〜4
```

基準日は **2026-07-29** です。Node.js、TypeScript、pnpm、GitHub Actions のバージョン番号は実装開始時に再確認し、設定ファイルにはその時点で検証した正確なバージョンを固定します。

---

## 1. 目的

テンプレートから生成した直後に、次の状態で TypeScript 製 npm パッケージの開発を始められることを目的とします。

- 公開 API と内部実装の境界が明確
- strict な型検査、lint、format、テスト、カバレッジが初日から有効
- npm に載る tarball そのものを、公開前に消費者視点で検証
- 依存追加、GitHub Actions、npm publish のサプライチェーンリスクを抑制
- Conventional Commits、SemVer、CHANGELOG、GitHub Release が一貫
- Claude Code、Codex などのエージェントが、同じコマンドと制約で安全に作業可能
- Windows、macOS、Linux の共同開発で設定差分が出にくい
- テンプレート自身の初期化処理も自動テスト済み

「設定が多いこと」ではなく、**公開後に壊れやすい契約を機械的に守れること**を品質とみなします。

---

## 2. スコープ

### 対象

- GitHub 上で公開する単一 npm パッケージ
- TypeScript で実装するライブラリ、またはライブラリ API を併設する CLI
- Node.js を開発・CI・publish 環境として利用
- npm registry へ公開
- OSS または将来 OSS 化するプロジェクト

### 初期プロファイル

| プロファイル | 用途 | 実行環境 | `zukai` での選択 |
|---|---|---|---|
| `node-library` | Node.js 向けライブラリ | Node.js 22.14 以上 | コア API に使用 |
| `node-cli` | CLI + import 可能な API | Node.js 22.14 以上 | **これを選択** |
| `universal-library` | Node.js と主要 bundler の双方から使うライブラリ | Web API の共通部分 | 将来の別用途向け |

プロファイル差分は bootstrap が生成時に確定します。全プロファイルの設定や不要なテスト依存を、生成後のリポジトリへ同居させません。

### 非対象

- Web アプリケーション、SSR フレームワーク、UI コンポーネントライブラリ
- 最初から複数パッケージを持つ monorepo
- CommonJS を既定で含む dual package
- Bun、Deno、Cloudflare Workers など全ランタイムの同時サポート
- 自動的な破壊的依存更新
- AI エージェントによる無承認 publish、push、PR 作成

2つ目の独立パッケージが実際に必要になるまでは、workspace/monorepo 化しません。

---

## 3. 決定事項

| # | 項目 | 既定 | 理由 |
|---|---|---|---|
| T1 | リポジトリ形態 | 単一パッケージ | 最小構成を維持し、不要な workspace 複雑性を避ける |
| T2 | パッケージマネージャ | pnpm 11 の互換 range を宣言し、解決版を lockfile に固定 | pnpm 11 の自己管理、厳格な依存解決、install script 承認、release age 制御を利用できる |
| T3 | 開発 Node.js | Node.js 24 LTS | 2026-07 時点の Active LTS |
| T4 | 最小 Node.js | 22.14 以上（Node プロファイル） | サポート中の LTS に限定し、CI で最小版を実測する |
| T5 | モジュール | ESM-only | dual package hazard と設定量を避ける |
| T6 | ビルド | `tsc` | 依存を増やさず、未 bundle の標準 ESM と型宣言を出す |
| T7 | bundler | 基本構成には入れない | bundle が要件になった時点で `tsdown` 等を ADR 付きで追加する |
| T8 | 型検査 | TypeScript strict + 追加 strictness | AI 生成コードを含め、曖昧さを早期に失敗させる |
| T9 | lint | ESLint flat config + typescript-eslint typed lint | 型情報を使う不具合検出を優先する |
| T10 | format | Prettier の正確な版を固定 | TS 以外の Markdown/YAML/JSON も同じ規則で整形する |
| T11 | テスト | Vitest + V8 coverage | TypeScript/ESM との相性と高速なフィードバック |
| T12 | 公開 API | `src/index.ts` と明示的 `exports` のみ | deep import と意図しない API 公開を防ぐ |
| T13 | API 差分 | API Extractor の report をコミット | 型レベルの破壊的変更をレビュー可能にする |
| T14 | 配布物検査 | publint + attw + tarball smoke test | ソースではなく、利用者が取得する成果物を検証する |
| T15 | バージョン管理 | Changesets + SemVer | PR 時点で変更意図と bump 種別を人間がレビューする |
| T16 | publish | npm trusted publishing（OIDC） | 長寿命の `NPM_TOKEN` を持たない |
| T17 | Git hooks | Lefthook | Node 以外のランタイムを要求せず、staged file に限定した高速チェックを行う |
| T18 | タスク入口 | `package.json` の scripts | npm パッケージ利用者が追加ツールなしで同じ操作を実行できる |
| T19 | AI 指示 | `AGENTS.md` を正本 | ツール固有ファイルによる規約の分岐を防ぐ |

### ESM-only の例外

既存の CommonJS 利用者が実測で重要だと判明した場合だけ、CJS を追加します。その際は次を必須とします。

1. 採用理由と対象利用者を ADR に記録
2. `import` と `require` の条件付き exports を分離
3. ESM/CJS の双方を tarball から実行
4. attw の strict profile を通す
5. 同一パッケージの ESM/CJS 二重ロードによる状態分裂をテスト

---

## 4. 文書構成

| ファイル | 内容 |
|---|---|
| **README.md**（本ファイル） | 位置づけ、スコープ、決定事項、全体完了条件 |
| [01-repository-design.md](01-repository-design.md) | リポジトリ構成、公開 API、TypeScript 設定、コマンド設計 |
| [02-quality-security-ai.md](02-quality-security-ai.md) | テスト、配布物検証、CI、依存セキュリティ、AI ネイティブ設計 |
| [03-bootstrap-release-and-dod.md](03-bootstrap-release-and-dod.md) | bootstrap、OSS 運用、release、段階的な実装順序、詳細な Definition of Done |

---

## 5. 全体の完了条件

次をすべて満たした時点で、汎用テンプレートを「完成」とします。

1. `node-library`、`node-cli`、`universal-library` の各生成テストが一時ディレクトリで成功する
2. 任意の placeholder が生成物に残っていない
3. `pnpm install --frozen-lockfile` と `pnpm check` がクリーン環境で成功する
4. 最小サポート Node.js と開発 Node.js の双方で振る舞いテストが成功する
5. npm tarball の中身が allowlist とサイズ上限を満たす
6. tarball を入れた一時 consumer から ESM import、型解決、公開 subpath が成功する
7. 未公開 deep import、ソースファイル、秘密情報、テスト fixture が tarball に含まれない
8. publint、attw、API report 検査、80% 以上の branch coverage が成功する
9. release workflow が tag と `package.json` の version 不一致を拒否する
10. publish job が長寿命 npm token を使わず、OIDC と保護 environment のみで構成される
11. GitHub Actions が最小権限、SHA pin、timeout、concurrency を満たす
12. `AGENTS.md` と機械的ガードにより、lockfile の手編集、秘密ファイルへのアクセス、`--no-verify`、plain force-push を防げる
13. README、CONTRIBUTING、SECURITY、CHANGELOG、LICENSE、Code of Conduct、Issue/PR template が生成後の package metadata と一致する
14. テンプレートから生成した検証用パッケージを、実際に npm の限定名またはローカル registry へ publish する rehearsal が成功する
15. `zukai` リポジトリを `node-cli` プロファイルから生成し、図解ツール固有コードを入れずに `pnpm check` が通る

未達項目を「後で対応」として黙って残しません。延期する場合は issue と理由、期限、受け入れるリスクを記録します。
