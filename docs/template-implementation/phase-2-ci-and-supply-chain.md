# Phase 2: CI and supply chain

> **前提**: Phase 1 完了（`pnpm check` フルが Node 22.14.0 / 24.18.1 の両方で exit 0）。
> 開始前に [README.md](README.md) と [decisions.md](decisions.md) を読むこと。

## 完了条件（仕様 03 §5）

> fork PR を含む CI が最小権限で通り、危険な dependency/Actions 変更が gate される。

GitHub 上での実行はこのセッションではできません。**ローカル proxy 検証**
（`actionlint` + `zizmor` + workflow の構造を assert するテスト）で担保し、
実際の PR 実行は maintainer の作業として手順に残します。

---

## セッション開始プロンプト

```
このリポジトリの Phase 2（CI and supply chain）を実装してください。

まず次を全文読む:
1. docs/template-implementation/README.md
2. docs/template-implementation/decisions.md   ← 検証済みの版・設計判断。再調査・再設計しない
3. docs/template-implementation/phase-2-ci-and-supply-chain.md（この文書）
4. docs/template-requirements/02-quality-security-ai.md §5, §6
5. docs/template-requirements/03-bootstrap-release-and-dod.md §6 の DoD F, G
6. 参考: /Users/masuyama/ghq/github.com/tomada1114/uv-template/.github/ 配下
   （workflow の構造・permissions・SHA pin の書き方を流用する。Python 固有部分は翻訳する）

要件の正本は docs/template-requirements/ で、実装の決定事項は decisions.md。

重要な前提:
- 最小 Node の job では pnpm に --config.runtime-on-fail=ignore が必要（decisions.md §3）
- pnpm-workspace.yaml の supply-chain policy は Phase 0 で実装済み。再設計しない
- third-party Actions は full commit SHA で pin し、コメントに release tag を書く。
  SHA は必ず一次資料（GitHub の該当 tag）で確認する。推測で書かない

禁止:
- 実際の push / PR 作成 / workflow dispatch / GitHub repository 設定の変更
- security gate の削除、permissions の緩和、pnpm-lock.yaml の手編集
- test の skip/disable、coverage 80% 閾値の引き下げ

完了時に、この文書の「検証」節のコマンドを実行し、command / summary / exit code を示すこと。
```

---

## 実装するもの

### 1. workflow（仕様 02 §5.2 の必須表）

| ファイル                                  | job / trigger          | 内容                                                               |
| ----------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `.github/workflows/ci.yml`                | `static`（PR, main）   | `format:check` / `lint` / `typecheck` / `api:check` / `docs:build` |
|                                           | `test`（PR, main）     | Node **22.14** と **24** の matrix、unit/integration + coverage    |
|                                           | `package`（PR, main）  | `build` / `publint` / `attw` / tarball smoke                       |
|                                           | `bootstrap`            | 3 profile + `zukai` の生成 repository full gate                    |
|                                           | `release impact`（PR） | release impact による release intent                               |
|                                           | `platform-smoke`       | Ubuntu / macOS / Windows で package import・CLI                    |
| `.github/workflows/codeql.yml`            | PR, push, schedule     | JavaScript/TypeScript security analysis                            |
| `.github/workflows/dependency-review.yml` | PR                     | 新規依存の脆弱性と license                                         |
| `.github/workflows/security-audit.yml`    | weekly, manual         | production dependency の audit（有限 retry 後 fail closed）        |
| `.github/workflows/scorecard.yml`         | weekly, manual         | OpenSSF Scorecard + SARIF                                          |
| `.github/workflows/typos.yml`             | PR, main               | code/docs の typo                                                  |
| `.github/workflows/check-pr-title.yml`    | PR                     | Conventional Commit 形式                                           |
| `.github/workflows/pr-label.yml`          | PR                     | type による best-effort label                                      |

`release.yml` は **Phase 4**。

### 2. 共通原則（仕様 02 §5.1）—— 全 job で守る

- `permissions` は **job 単位で最小化**。top-level は `permissions: {}` か `contents: read`
- third-party Actions は **full commit SHA で pin**、末尾コメントに release tag
- `actions/checkout` は `persist-credentials: false`
- 全 job に `timeout-minutes`
- `concurrency` で PR の重複 run を cancel
- install は `pnpm install --frozen-lockfile`
- release job では cache を使わない（Phase 4）
- fork PR へ write permission / secret を渡さない
- `pull_request_target` で fork のコードを実行しない
- shell script は `set -euo pipefail` 相当、または Node script に寄せる

### 3. coverage の正本を1つにする

仕様 02 §5.2 末尾: **platform matrix 全体で coverage を重複取得しない。**
最小 Node（22.14）の Ubuntu job を coverage の正本にし、他は互換性検査に絞る。

### 4. pnpm セットアップの型

`corepack` + `devEngines.packageManager` で pnpm を解決します。
トップレベルの `packageManager` フィールドは corepack と Dependabot が読む exact
version として持ち、`devEngines.packageManager.version` も**同一文字列**にします
（decisions.md §1「pnpm」）。CI では `corepack pnpm@<version>` 相当の明示指定か、
`pnpm/action-setup` を SHA pin して使うかを選び、**理由をコメントに書く**。

最小 Node job だけ `--config.runtime-on-fail=ignore` を付ける（decisions.md §3）。
**このフラグを付ける理由をワークフロー内にコメントで残すこと** —— さもないと
次の人が「不要なバイパス」と誤解して外し、job が壊れます。
また、このフラグ付きの `install` は実効値を `package.json` に書き戻すので、
直後に `git restore package.json` を置くこと（decisions.md §3）。

### 5. supply chain 設定

| ファイル                          | 内容                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `.github/dependabot.yml`          | npm と github-actions を weekly、`cooldown.default-days: 7`、patch/minor を group、major は分離、`commit-message.prefix` |
| `.github/zizmor.yml`              | 意図的な例外だけを ignore（理由コメント必須）                                                                            |
| `.github/release.yml`             | GitHub の自動 release note のカテゴリ（label と対応）                                                                    |
| `typos.toml`                      | `extend-exclude` に `pnpm-lock.yaml`、`etc/*.api.md`                                                                     |
| `.devcontainer/devcontainer.json` | Node 24 image + pnpm、`postCreateCommand` は frozen install                                                              |

`pnpm-workspace.yaml`（release age / trust / install script policy）は **Phase 0 で実装済み**。
内容の再設計はせず、`.claude/rules/` からの参照は Phase 3 で行う。

### 6. `tests/workflows.test.ts` —— ローカル proxy 検証

GitHub 上で走らせられない代わりに、**workflow の構造を機械的に assert** します。
これが DoD G のローカル証跡になります。

- `.github/workflows/*.yml` を列挙し、各ファイルについて:
  - すべての `uses:` が `owner/repo@<40 桁 hex>` 形式（SHA pin）であること。
    ただし `actions/*` を含む first-party も pin 対象。ローカル action（`./`）は除外
  - 各 `uses:` 行に release tag のコメント（`# vX.Y.Z`）があること
  - すべての job に `timeout-minutes` があること
  - top-level か job に `permissions` があり、`write-all` を使っていないこと
  - `actions/checkout` の step に `persist-credentials: false` があること
  - PR trigger を持つ workflow に `concurrency` があること
  - `pull_request_target` を使っていないこと
  - `pnpm install` を含む run はすべて `--frozen-lockfile` を伴うこと
- CI の test matrix に `engines.node` の最小版（`22.14`）と `.node-version`（`24`）の
  両方が含まれること（仕様 03 §1.2 の「`.node-version`、CI matrix の整合」）

YAML パーサは依存を増やしたくないので、**正規表現ベースの行スキャン**で十分です
（`yaml` package を足すかは、必要性を判断して報告する。足す場合は仕様 01 §6 の
依存審査項目を PR に記録すること）。

### 7. `actionlint` / `zizmor` によるローカル検査

`mise` に `actionlint 1.7.12` と `shellcheck 0.11.0` が既に入っています（decisions.md §16）。

```bash
mise exec actionlint -- actionlint .github/workflows/
```

`zizmor` は Python ツールなので、ローカルでは `uvx zizmor .github/workflows/` を使うか、
未導入なら「CI 上で実行され、ローカルでは actionlint までを必須にする」と明記する。
**どちらにしたかを報告すること。**

---

## 検証

```bash
# 既存の gate が壊れていないこと
pn24 run check
pn22 run check

# workflow の構造テスト
pn24 run test

# workflow の構文・セキュリティ検査
mise exec actionlint -- actionlint .github/workflows/
uvx zizmor .github/workflows/     # 実行できない場合は理由を報告

# 作業ツリーが汚れていないこと
git status --short
```

期待: 全て exit 0。`actionlint` / `zizmor` の指摘は**抑制せず修正**する。
どうしても例外が必要なら `.github/zizmor.yml` に理由付きで記録する。

---

## DoD 対応

| DoD | 項目                                           | 対応                                                      |
| --- | ---------------------------------------------- | --------------------------------------------------------- |
| F   | lockfile が committed で frozen install を使用 | `tests/workflows.test.ts` の `--frozen-lockfile` assert   |
| F   | release age 7日 / fail-closed policy           | Phase 0 の `pnpm-workspace.yaml`（再掲・検証のみ）        |
| F   | provenance downgrade を拒否                    | 同上 `trustPolicy: no-downgrade`                          |
| F   | transitive exotic source を拒否                | 同上 `blockExoticSubdeps: true`                           |
| F   | lifecycle script が allowlist                  | 同上 `strictDepBuilds` + `allowBuilds`                    |
| F   | dependency review / audit / CodeQL / Scorecard | 各 workflow                                               |
| F   | Dependabot に cooldown と group 方針           | `.github/dependabot.yml`                                  |
| G   | Node 最小版と Node 24                          | `ci.yml` の test matrix                                   |
| G   | Ubuntu と package smoke の macOS/Windows       | `platform-smoke` job                                      |
| G   | permissions は job 最小単位                    | workflow + 構造テスト                                     |
| G   | Actions は SHA pin                             | 構造テスト                                                |
| G   | checkout credential を残さない                 | 構造テスト                                                |
| G   | timeout と concurrency                         | 構造テスト                                                |
| G   | fork PR へ secret/write を渡さない             | workflow レビュー + `pull_request_target` 不使用の assert |
| G   | zizmor が workflow を検査                      | `ci.yml` の zizmor job                                    |

### maintainer に残す手順（Phase 4 の checklist に統合する）

- 初回 PR を出して全 workflow が green になることを確認する
- `security-audit` / `scorecard` を `workflow_dispatch` で一度手動実行する
- Scorecard の指摘を確認し、未対応は理由を記録する（DoD J）

---

## やらないこと

- `release.yml`（Phase 4）
- AGENTS.md / `.claude/`（Phase 3）
- Codecov の導入判断は保留可。使う場合は fork PR への token 方針を明記する（仕様 03 §4）
