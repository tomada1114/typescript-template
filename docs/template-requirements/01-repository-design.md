# 01. リポジトリとパッケージ契約の設計

## 1. 最上位の原則

### 1.1 npm tarball が製品

開発中の `src/` が動くことだけでは不十分です。利用者が受け取るのは npm registry 上の tarball なので、ビルド、型宣言、exports、CLI、同梱ファイルを tarball 単位で検証します。

これは `uv-template` の「ローカルソースではなく、build した wheel を一時環境へ install して import する」という考え方を、そのまま npm 向けに移したものです。

### 1.2 公開 API は少なく、明示的にする

- 原則として root export `.` だけから開始
- public symbol は `src/index.ts` から名前付き export
- default export は使わない
- `exports` にない deep import は非公開契約
- public API には型注釈と TSDoc を付ける
- `package.json`、README 例、API report、API docs を同時に更新
- internal module は `src/internal/` へ置き、public barrel から export しない

### 1.3 設定の重複を作らない

- 開発者と CI の正本は `package.json` scripts
- Git hook と AI hook も同じ scripts を呼ぶ
- Node.js と pnpm の版は機械可読な1箇所を正本にし、他はそこへ揃える
- build entry と package exports の二重管理はテストで差分を検出
- `justfile` は既定では置かない。Node 利用者に追加インストールを要求しないため

---

## 2. 推奨ファイル構成

```
my-package/
├── .changeset/
│   ├── README.md
│   └── config.json
├── .claude/
│   ├── hooks/
│   │   ├── format.mjs
│   │   ├── guard.mjs
│   │   └── stop-check.mjs
│   ├── rules/
│   │   ├── docs.md
│   │   ├── package-json.md
│   │   ├── source.md
│   │   └── testing.md
│   └── settings.json
├── .devcontainer/
│   └── devcontainer.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── codeql.yml
│   │   ├── dependency-review.yml
│   │   ├── release.yml
│   │   ├── scorecard.yml
│   │   └── security-audit.yml
│   ├── dependabot.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── zizmor.yml
├── docs/
│   ├── getting-started.md
│   └── reference.md
├── etc/
│   └── my-package.api.md
├── scripts/
│   ├── bootstrap.mjs
│   ├── check-package.mjs
│   └── smoke-package.mjs
├── src/
│   ├── internal/
│   ├── cli.ts                 # node-cli のみ
│   └── index.ts               # public API の唯一の起点
├── tests/
│   ├── fixtures/
│   ├── bootstrap.test.ts
│   ├── index.test.ts
│   └── package.test.ts
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .node-version
├── .prettierignore
├── .prettierrc.json
├── AGENTS.md
├── CHANGELOG.md
├── CLAUDE.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── SECURITY.md
├── eslint.config.mjs
├── lefthook.yml
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.build.json
├── tsconfig.json
├── typedoc.json
├── typos.toml
└── vitest.config.ts
```

単一パッケージでも `pnpm-workspace.yaml` を置きます。pnpm 11 の supply-chain 設定、build script 承認、release age、peer dependency 方針をプロジェクト単位で宣言する正本にするためです。`packages/` ディレクトリは作りません。

### 2.1 置かないもの

- `src/utils.ts` のような無関係な処理の寄せ集め
- root と `src/` の複数 barrel
- `index.ts` からの無差別な `export *`
- 生成済み `dist/`
- `.env`、token、private key
- bundler 設定（要件が発生するまでは不要）
- npm/pnpm/yarn の複数 lockfile

---

## 3. `package.json` の契約

概念上、次の項目を必須とします。値は bootstrap が package 名、GitHub owner、説明、ライセンス、profile に応じて生成します。

```jsonc
{
  "name": "my-package",
  "version": "0.1.0",
  "description": "A short description.",
  "type": "module",
  "license": "MIT",
  "author": "Your Name",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/your-name/my-package.git"
  },
  "bugs": {
    "url": "https://github.com/your-name/my-package/issues"
  },
  "homepage": "https://github.com/your-name/my-package#readme",
  "engines": {
    "node": ">=22.14"
  },
  "devEngines": {
    "runtime": {
      "name": "node",
      "version": "^24.0.0",
      "onFail": "error"
    },
    "packageManager": {
      "name": "pnpm",
      "version": "^11.18.0",
      "onFail": "download"
    }
  },
  "files": ["dist"],
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "types": "./dist/index.d.ts",
  "publishConfig": {
    "access": "public"
  }
}
```

### 必須ルール

- `repository.url` は npm trusted publishing の対象 GitHub リポジトリと大文字小文字まで一致
- pnpm 11 では `pnpm init --init-package-manager` が `devEngines.packageManager` を生成する。互換 range を宣言し、実際に使う pnpm と standalone executable の正確な版を `pnpm-lock.yaml` に記録
- `files` は allowlist。denylist で配布物を調整しない
- `exports` は entry ごとに明示。wildcard export は既定で禁止
- `types` condition を実装より先に置く
- `sideEffects: false` は事実である場合だけ設定。import 時に登録処理等を行う package では削除または配列指定
- runtime dependency は `dependencies`
- consumer が用意すべき統合先は `peerDependencies` とし、対応範囲を広く保つ
- build/test/lint のみで使うものは `devDependencies`
- optional な重い機能は `optionalDependencies` または別 package 化を、実測後に判断
- Node 組み込み module は `node:` prefix を使う
- `node-cli` だけ `bin` を持ち、出力ファイルの shebang と executable bit を smoke test する

`main`、`module` は古い consumer の実測要件がなければ追加しません。追加した場合は `exports` と食い違わないことを publint で検証します。

---

## 4. TypeScript 設定

### 4.1 共通の型検査

`tsconfig.json` は emit せず、source、tests、scripts、config を検査します。

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUncheckedSideEffectImports": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "forceConsistentCasingInFileNames": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests", "scripts", "*.ts", "*.mts"]
}
```

実装時は利用する TypeScript 版の有効な option 名を `tsc --showConfig` で確認します。未知の option や無効な config を黙って無視させません。

### 4.2 build 専用設定

`tsconfig.build.json` は `tsconfig.json` を継承し、公開成果物だけを emit します。

- `rootDir: "src"`
- `outDir: "dist"`
- `noEmit: false`
- `declaration: true`
- `declarationMap: true`
- `sourceMap: true`
- `isolatedDeclarations: true`
- tests、scripts、config を exclude
- build 前に `dist/` を消去

`isolatedDeclarations` により public symbol に明示的な型が必要になります。これは制約ではなく、公開 API の意図をコードレビューと AI エージェントへ伝えるための設計です。

### 4.3 profile 差分

| 項目 | `node-library` / `node-cli` | `universal-library` |
|---|---|---|
| `lib` | ES のみ | ES + DOM の必要最小限 |
| Node types | 使用可 | source では禁止 |
| `engines.node` | `>=22.14` | consumer 契約には原則記載しない |
| build platform | Node | neutral |
| smoke test | Node ESM | Node ESM + bundler consumer |
| CLI | `node-cli` のみ | なし |

universal profile で Node 専用 API が必要になった場合は、条件付き export の別 entry へ隔離します。

---

## 5. `tsc` を既定にする理由

ライブラリテンプレートの初期状態では、依存の bundle、単一ファイル化、CJS、minify は要件ではありません。`tsc` だけで標準 ESM と `.d.ts` を出せるため、まずは次を優先します。

- build tool の runtime dependency と設定を減らす
- source module と出力 module の対応を明瞭にする
- consumer の bundler に tree-shaking を委ねる
- runtime dependency を勝手に bundle しない
- TypeScript の module resolution と実行時挙動の差を小さくする

### bundler 導入条件

次のいずれかを計測で確認した場合だけ導入します。

- CLI の起動時間または配布ファイル数が問題
- browser 向けに単一 bundle が必要
- 複数 format の生成が必要
- source をそのまま配ると内部 module 構成が契約化してしまう
- bundle size report や asset copy が build の中心要件になる

候補は `tsdown` ですが、2026-07 時点では 0.x 系です。採用時は ADR、版の固定、exports のレビュー、publint/attw、tarball smoke test を必須にします。自動生成された `exports` を無レビューで publish しません。

---

## 6. 基本依存

placeholder package の `dependencies` は空から始めます。基本 `devDependencies` も、完了条件を強制するものだけに限定します。

| 目的 | package |
|---|---|
| compiler | `typescript` |
| Node 型（Node profile のみ） | `@types/node` |
| lint | `eslint`、`@eslint/js`、`typescript-eslint`、`eslint-config-prettier` |
| format | `prettier` |
| test/coverage | `vitest`、`@vitest/coverage-v8` |
| public API | `@microsoft/api-extractor` |
| package 検証 | `publint`、`@arethetypeswrong/cli` |
| API docs | `typedoc` |
| release intent | `@changesets/cli` |
| Git hooks | `lefthook` |

依存を減らすため、clean、copy、tarball inspection、consumer fixture の生成は小さな Node `.mjs` script で実装します。汎用 helper package を安易に追加しません。

追加 lint plugin、property-based testing、browser runner、bundler、size analysis は、対象 package の要件が発生してから追加します。

---

## 7. コマンド設計

すべての利用者と自動化が `package.json` scripts を共通利用します。

| コマンド | 契約 |
|---|---|
| `pnpm build` | `dist/` をクリーンにして JS、source map、declaration を生成 |
| `pnpm clean` | 既知の生成物だけを削除。source、lockfile、ユーザーファイルに触れない |
| `pnpm format` | Prettier で書き換える |
| `pnpm format:check` | 書き換えず format 差分を検査 |
| `pnpm lint` | typed lint、warning も失敗 |
| `pnpm typecheck` | emit なしで全対象を型検査 |
| `pnpm test` | unit/integration を一度実行 |
| `pnpm test:watch` | ローカル対話用。CI では使用しない |
| `pnpm test:coverage` | branch を含む coverage gate |
| `pnpm api:check` | committed API report との差分を検査 |
| `pnpm api:update` | 意図した API 変更時だけ report を更新 |
| `pnpm package:lint` | publint + attw |
| `pnpm package:smoke` | tarball 作成、内容検査、一時 consumer で実行 |
| `pnpm docs:build` | TypeDoc を warning なしで生成 |
| `pnpm check:quick` | format check + lint + typecheck + unit test |
| `pnpm check` | coverage、build、API、tarball、docs を含む全 gate |
| `pnpm fix` | lint autofix の後に Prettier。最終整形者は Prettier |

`pnpm check` はファイルを書き換えません。CI の合否とローカル実行結果を一致させるためです。修正が必要な操作は `pnpm fix` に分離します。

### 完了条件

1. すべての script が macOS/Linux/Windows で shell 固有構文なしに動く
2. `pnpm check` の単独実行で release 前 gate を再現できる
3. `pnpm check` 後に working tree が変化しない
4. 各下位 script を単独実行しても前提不足で壊れない、または前提を明確なエラーで示す
5. CLI の失敗は非0 exit code と対処可能なメッセージを返す

---

## 8. ドキュメントとメタデータ

- README: 30秒で価値、install、最小例、互換性、API 入口が分かる
- CONTRIBUTING: setup、主要コマンド、テスト、Changeset、PR 手順
- SECURITY: private report 経路、対応版、応答目安
- CHANGELOG: Keep a Changelog の分類と SemVer
- LICENSE: SPDX と `package.json.license` を一致
- API docs: TypeDoc で public export だけを出力
- TSDoc: 型から明らかな「何をするか」を繰り返さず、制約、副作用、例外、単位、性能特性を記載
- example code: CI で compile または実行し、古い例を残さない

公開 API を変更する PR は、実装、振る舞いテスト、型テスト、API report、README/API docs、Changeset を同じ PR で更新します。
