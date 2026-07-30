# テンプレート実装ガイド（セッション分割用）

このディレクトリは、`typescript-template` を Phase 0 → 5 まで作り切るための**作業側**ドキュメントです。
要件の正本は `docs/template-requirements/`（および外部の `zenn-content` 側の同名4文書）で、
このディレクトリは「いま何が出来ていて、次のセッションで何をやるか」を引き継ぐためだけに存在します。

各 Phase を**別セッション**で進めます。セッションを開始したら、まず
`docs/template-implementation/phase-N-*.md` を読み、その中の「セッション開始プロンプト」に従ってください。

| ファイル                                                                   | 用途                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **README.md**（本ファイル）                                                | 現在地、環境構築、共通ルール、Phase 一覧、DoD 対応表                           |
| [decisions.md](decisions.md)                                               | **一次資料で検証済みの版・設計判断・既知の落とし穴**（再調査しないための正本） |
| [phase-1-publish-artifact-quality.md](phase-1-publish-artifact-quality.md) | API Extractor / publint / attw / tarball smoke / TypeDoc                       |
| [phase-2-ci-and-supply-chain.md](phase-2-ci-and-supply-chain.md)           | CI matrix / CodeQL / audit / Scorecard / zizmor / Dependabot                   |
| [phase-3-ai-native-workflow.md](phase-3-ai-native-workflow.md)             | AGENTS.md / path-scoped rules / hooks / Lefthook                               |
| [phase-4-bootstrap-and-release.md](phase-4-bootstrap-and-release.md)       | bootstrap / OSS 文書 / Changesets / OIDC release / 生成 E2E                    |
| [phase-5-generated-repo-ai-layer.md](phase-5-generated-repo-ai-layer.md)   | 生成物の AGENTS.md / `.claude/**` を bootstrap と整合させる                    |

> **重要**: `decisions.md` は Phase 0 の実装中に一次資料（npm registry、nodejs.org、各 CLI の
> `--help`）で確認した事実と、そこから決めた設計をまとめたものです。**同じ調査を繰り返さないでください。**
> 特にバージョン選定と `attw` / `devEngines` の非互換は、知らずに進むと必ず踏みます。

---

## 1. 現在地: Phase 3 完了

### 完了条件（仕様 03 §5 Template Phase 3）

> 通常変更は高速に進められ、protected file と publish/Git bypass は決定論的に拒否される。

### 検証済み（2026-07-30 時点、fresh run）

Phase 3 セッションで実測した値です。Phase 1・2 の成果物も同じ実行に含まれています。

| コマンド                 | 環境                        | 結果                                                               |
| ------------------------ | --------------------------- | ------------------------------------------------------------------ |
| `pnpm run check`（フル） | Node 24.18.1 / pnpm 11.18.0 | exit 0（7 files / 286 tests passed）                               |
| `pnpm run check`（フル） | Node 22.14.0 / pnpm 11.18.0 | exit 0（286 tests passed、`--config.runtime-on-fail=ignore` 付き） |
| coverage                 | Node 24.18.1                | Stmts 92.64 / Branch 88.23 / Funcs 84.21 / Lines 92.59（閾値 80）  |
| `lefthook validate`      | Node 24.18.1                | exit 0                                                             |

> Phase 1〜3 の成果物は**作業ツリーに未コミットで存在**します（この repo の運用どおり、
> 人間がレビューしてコミットする）。`git status --short` で確認してください。

### 現在のファイル構成

Phase 0〜3 で追加されたもののみ。生成物（`dist/`, `coverage/`, `docs/api/`, `temp/`）は省略。

```
typescript-template/
├── .claude/                       # Phase 3
│   ├── hooks/                     #   guard / format / stop-check + lib/payload
│   ├── rules/                     #   source / testing / docs / package-json
│   ├── skills/merge-dependabot/   #   唯一同梱する workflow skill
│   └── settings.json              #   permission allowlist と hook 登録
├── .github/                       # Phase 2
│   ├── workflows/                 #   ci / codeql / scorecard / audit / zizmor ほか
│   ├── dependabot.yml
│   └── zizmor.yml
├── docs/
│   ├── template-requirements/     # 要件4文書のコピー（日本語・変更しない）
│   └── template-implementation/   # このディレクトリ
├── etc/                           # Phase 1: API Extractor の report（tracked）
├── scripts/                       # Phase 0〜1
│   ├── lib/                       #   is-main / json / node-tools / tarball
│   ├── check-attw.mjs
│   ├── check-package.mjs
│   ├── clean.mjs
│   └── smoke-package.mjs
├── src/
│   ├── internal/assert.ts         # 非公開ヘルパ（public barrel から export しない）
│   ├── bin.ts                     # node-cli: shebang 付き実行エントリ
│   ├── cli.ts                     # node-cli: テスト可能な runCli(argv, io)
│   ├── errors.ts                  # InvalidInputError / TimeoutError
│   ├── identifier.ts              # normalizeIdentifier
│   ├── index.ts                   # public API の唯一の起点
│   └── timeout.ts                 # withTimeout
├── tests/
│   ├── cli.test.ts                # runCli の正常系・usage error(2)・rejected input(1)
│   ├── hooks.test.ts              # Phase 3: hook の許可系・拒否系 fixture test
│   ├── index.test.ts              # normalizeIdentifier の正常/異常/境界
│   ├── package.test.ts            # Phase 1: tarball 解析と allowlist
│   ├── timeout.test.ts            # timeout / abort / cleanup / 同期 throw
│   ├── types.test.ts              # expectTypeOf による型テスト
│   └── workflows.test.ts          # Phase 2: workflow の構造 assert
├── AGENTS.md                      # Phase 3: 全エージェント共通の正本
├── CLAUDE.md                      # Phase 3: @AGENTS.md + Claude 固有の差分だけ
├── api-extractor.json             # Phase 1
├── eslint.config.mjs              # flat config + typed lint
├── lefthook.yml                   # Phase 3: pre-commit（staged 限定）/ pre-push（check:quick）
├── package.json                   # my-package@0.1.0 / ESM-only / node-cli profile
├── pnpm-lock.yaml                 # 生成物・手編集禁止
├── pnpm-workspace.yaml            # pnpm 11 supply-chain policy
├── tsconfig.build.json
├── tsconfig.json
├── typedoc.json                   # Phase 1
├── typos.toml                     # Phase 2
└── vitest.config.ts
```

### Phase 4 以降で入るもの

- `scripts/bootstrap.mjs` と `tests/bootstrap.test.ts`（Phase 4）
- `.changeset/`、`.github/workflows/release.yml`、Issue / PR template（Phase 4）
- LICENSE / CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / CHANGELOG（Phase 4）
- `docs/maintainer-checklist.md` と `scripts/check-repo-settings.mjs`（Phase 4）
- 生成物側の `AGENTS.md` / `.claude/**` を bootstrap と整合させる変換（Phase 5）

---

## 2. 環境構築（セッションごとに最初に実行）

グローバル既定は変更しません。`mise` でバージョンを用意し、`corepack` 経由で pnpm を使います。

```bash
# 一度だけ: Node を2系統入れる（グローバル既定は変えない）
mise install node@24.18.1 node@22.14.0

# 動作確認
mise exec node@24.18.1 -- node --version   # v24.18.1
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 mise exec node@24.18.1 -- corepack pnpm@11.18.0 --version  # 11.18.0
```

毎回打つのが長いので、セッション用の一時ラッパを作ると楽です（**repo 内には置かない**）。

```bash
mkdir -p "$TMPDIR/tstmpl"

cat > "$TMPDIR/tstmpl/pn24" <<'EOF'
#!/bin/sh
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
exec "$HOME/.local/bin/mise" exec node@24.18.1 -- corepack pnpm@11.18.0 "$@"
EOF

# 最小サポート Node では devEngines.runtime のチェックを明示的に外す（decisions.md §3）
cat > "$TMPDIR/tstmpl/pn22" <<'EOF'
#!/bin/sh
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
exec "$HOME/.local/bin/mise" exec node@22.14.0 -- corepack pnpm@11.18.0 --config.runtime-on-fail=ignore "$@"
EOF

chmod +x "$TMPDIR/tstmpl/pn24" "$TMPDIR/tstmpl/pn22"
export PATH="$TMPDIR/tstmpl:$PATH"
```

以降このドキュメント群では `pn24` / `pn22` と書きます。

---

## 3. 全 Phase 共通のルール

### 進め方

1. 新しい振る舞いは**テストを先に書き、red を確認してから**実装する。
2. 小さな論理単位で進め、各反復後に何が終わり何が残っているかを報告する。
3. 仕様に明示された設計を**再設計しない**。`decisions.md` の決定も再設計しない。
4. 実装中にバージョンや CLI 仕様を固定する前に、公式の一次資料で現在値を確認する
   （`decisions.md` に載っているものは再確認不要）。

### 禁止事項

- test の skip / disable / 削除、assertion の弱体化
- coverage 80% 閾値の引き下げ
- stub / mock だけで gate を通す
- 型エラーや lint の抑制（`@ts-ignore`、無条件の `eslint-disable`）
- security gate の削除
- `pnpm-lock.yaml` の手編集
- `--no-verify`、force push、実 publish、秘密情報へのアクセス
- 実 npm publish / GitHub repository 設定変更 / push / PR 作成 / workflow dispatch

### 言語

- repository に置く code、comment、設定、**公開** docs は英語。
- `docs/template-requirements/` の日本語4文書はそのまま保持。
- `docs/template-implementation/`（このディレクトリ）は作業用なので日本語で可。
  Phase 4 の bootstrap は、生成先リポジトリから `docs/template-requirements/` と
  `docs/template-implementation/` の**両方**を削除する。

### スコープ

- `zukai` 固有の実装（Playwright、Iconify、MCP、画像 golden test）は入れない。
- 派生的に気づいた改善は編集せず、別途リストアップして報告する。

---

## 4. Definition of Done 対応表（仕様 03 §6）

各項目をどの Phase で満たすかの割り当てです。Phase 完了時は、担当分について
「実装済み＋fresh な検証結果」または「外部サービス上で人間が行う設定＋ローカル proxy 検証と手順」
を示します。

| DoD   | 内容                                                                             | 担当 Phase                                |
| ----- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| **A** | テンプレートとしての再利用性（3 profile、bootstrap、placeholder ゼロ）           | 4 + 5（指示文書と `.claude/**` の整合）   |
| **B** | package 契約（ESM-only、exports/files allowlist、deep import 拒否、API report）  | 0（契約）+ 1（report / deep import 検証） |
| **C** | 型・lint・format（strict、typed lint、非破壊 `pnpm check`）                      | 0（実装）+ 1（`pnpm check` フル green）   |
| **D** | テスト（正常/異常/境界、async cleanup、型テスト、branch 80%）                    | 0                                         |
| **E** | build と tarball（publint / attw / allowlist / size / consumer / CLI）           | 1                                         |
| **F** | dependency と security（frozen install、release age、audit、CodeQL、Dependabot） | 0（pnpm policy）+ 2（CI 側）              |
| **G** | CI（Node 2版、OS 3種、最小権限、SHA pin、timeout、concurrency、zizmor）          | 2                                         |
| **H** | release（Changeset、tag/version 照合、単一 tarball、OIDC、attestation）          | 4                                         |
| **I** | AI ネイティブ（AGENTS.md、path-scoped rules、hooks、fixture test）               | 3 + 5（生成物側でも成立させる）           |
| **J** | OSS の見え方（README / CONTRIBUTING / SECURITY / LICENSE / CoC / templates）     | 4                                         |

### ローカルで完結しない項目の扱い

次はローカルで実行できないため、**ローカル proxy 検証 + maintainer 向け手順**で満たします
（詳細は Phase 2 / Phase 4 の該当節）。

| 項目                                   | ローカル proxy 検証                                            | 人間の作業                          |
| -------------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| GitHub Actions の実行                  | `actionlint` + `zizmor` + workflow の構造を assert する test   | PR で実際に走らせる                 |
| branch protection / secret scanning 等 | `scripts/check-repo-settings.mjs`（`gh api` read-only）        | GitHub UI で設定                    |
| npm trusted publishing (OIDC)          | ローカル registry または packed tarball の検査 + dry rehearsal | npmjs.com で trusted publisher 登録 |
| GitHub Environment `release`           | workflow に `environment: release` があることを assert         | required reviewer 設定              |

---

## 5. 最終ゴール（Phase 5 完了時）

仕様 README §5 の15項目と 03 §6 の DoD A〜J を全て満たし、次が exit 0 になること。

Phase 4 で下の全コマンドが exit 0 になり、Phase 5 は生成物の指示文書
（`AGENTS.md` / `CLAUDE.md` / `.claude/**`）がその生成物自身を正しく説明していることを
足します。**Phase 4 の完了条件は変わりません。**

```bash
# クリーン環境での frozen install と フルチェック（両 Node）
pn24 install --frozen-lockfile && pn24 run check
pn22 install --frozen-lockfile && pn22 run check

# 3 profile の生成 E2E（一時ディレクトリ）
#   node-library / node-cli / universal-library それぞれで
#   bootstrap → pnpm install --frozen-lockfile → pnpm check が green

# node-cli profile で一時的に zukai を生成し、pnpm check が green
```

このリポジトリではコミットしません。作業ツリーに残し、人間がレビューしてコミットします。
