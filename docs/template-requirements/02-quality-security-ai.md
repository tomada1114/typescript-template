# 02. 品質・セキュリティ・AI ネイティブ設計

## 1. 品質ゲートの層

単一の「テスト成功」では npm パッケージの品質を保証できません。失敗の種類ごとに gate を分けます。

| 層 | 検出する問題 | 主な手段 |
|---|---|---|
| 形式 | 無意味な差分、設定ファイルの崩れ | Prettier、EditorConfig |
| 静的品質 | promise、型 narrowing、unsafe operation、dead code | ESLint + typescript-eslint typed lint |
| 型 | source/test/script の型不整合 | `tsc --noEmit` |
| 振る舞い | 正常系、異常系、境界、状態遷移 | Vitest |
| 公開 API | 意図しない export、型契約の変更 | API Extractor report |
| build | declaration/source map/entry の欠落 | `tsc -p tsconfig.build.json` |
| package metadata | exports と実ファイルの不一致 | publint |
| consumer 型解決 | NodeNext/bundler で型だけ壊れる問題 | Are the Types Wrong |
| 配布物 | 不要ファイル、deep import、CLI、実行時依存 | tarball smoke test |
| supply chain | 脆弱依存、危険な Actions、公開経路 | dependency review、audit、CodeQL、zizmor、Scorecard |

gate を抑制コメントで通しません。例外が必要なら、対象を最小化し、理由、issue、削除条件を記載します。

---

## 2. lint と format

### ESLint

- flat config
- `typescript-eslint` の `strictTypeChecked` と `stylisticTypeChecked`
- `parserOptions.projectService: true`
- warning も CI 失敗
- unused disable directive を error
- generated `dist/` と coverage だけを global ignore
- tests と scripts は必要な差分だけ override
- `any` は原則禁止。外部 boundary では `unknown` を受けて narrow
- floating promise、misused promise、unsafe assignment/call/return/member access を error
- `@ts-ignore` を禁止し、必要時は理由付き `@ts-expect-error`
- `@ts-expect-error` が不要になったら TypeScript 自身が失敗させる

strict preset は semver 上で rule 構成が変わり得るため、依存更新 PR では新規 error を「無効化して通す」のではなく、rule の狙いとコードをレビューします。

### Prettier

- exact version を `devDependencies` に固定
- TypeScript だけでなく JSON、YAML、Markdown を対象
- ESLint と整形責務を競合させない
- CI は `prettier --check`
- editor 固有設定より repository config を優先

---

## 3. テスト戦略

### 3.1 振る舞いテスト

- source の directory 構成や private helper ではなく public behavior を検査
- public function ごとに正常系、入力不正、境界、依存障害を検査
- error class、error code、message の安定部分を検査
- network、filesystem、clock、random、process は boundary で差し替え
- `setTimeout` や実時間 sleep に依存しない
- test 順序、timezone、locale、CPU 数に依存しない
- mock は boundary に限定し、過剰な call count 検査を避ける
- async 処理では timeout、abort/cancellation、cleanup を検査
- 外部 API は失敗、429、timeout、不正 response を前提にする

### 3.2 型テスト

public API について、少なくとも次を compile-time test します。

- 推論される戻り値と generic
- 許可する入力
- 拒否する入力（理由付き `@ts-expect-error`）
- discriminated union の narrowing
- public subpath ごとの import
- ESM consumer の NodeNext resolution
- universal profile の bundler resolution

Vitest の `expectTypeOf` と独立 consumer fixture の `tsc` を使い分けます。source 自体の型検査だけで、consumer から見た declaration の正しさを代用しません。

### 3.3 coverage

- V8 provider
- lines、functions、statements、branches をすべて 80% 以上
- branch coverage を必須
- generated code、型だけのファイル、到達不能な platform branch だけを明示除外
- threshold を下げる変更は、ユーザーの明示承認と理由を必要とする
- 数字を満たすためだけの trivial test は追加しない

複雑な parser、schema、状態機械、path 処理には `fast-check` 等の property-based test を検討します。ただし placeholder package には依存を入れず、適用条件を `AGENTS.md` に記載します。

---

## 4. tarball smoke test

`scripts/smoke-package.mjs` は repository source を直接 import せず、毎回一時ディレクトリで次を行います。

1. clean build
2. `pnpm pack` で `.tgz` を1個だけ生成
3. tarball 内の path を allowlist と照合
4. `.env`、secret、source、test、fixture、cache、local config がないことを検査
5. unpacked size、file count、最大単一ファイルサイズを configurable threshold と照合
6. 空の ESM consumer を作り、tarball を install
7. package root と全公開 subpath を dynamic import
8. `package.json` の version と実行時 version API がある場合は一致を確認
9. 一時 TypeScript consumer を NodeNext で compile
10. universal profile は bundler resolution の consumer も compile/build
11. node-cli は `--help`、`--version`、不正引数、失敗時 exit code、stderr を実行
12. consumer から非公開 deep import が失敗することを確認
13. 一時ディレクトリを成功・失敗の両方で cleanup

`npm pack --dry-run` の表示だけで済ませません。install 後の module resolution と declaration resolution まで検証します。

### package 完了条件

- publint の error/warning がゼロ
- attw は ESM-only profile で error ゼロ
- tarball の公開 entry がすべて runtime import 可能
- consumer の `tsc` が repository 内の source path を参照していない
- source map と declaration map の path が repository 外の絶対 path を含まない
- package size threshold の変更が review diff に現れる

---

## 5. CI 設計

### 5.1 共通原則

- job ごとに `permissions` を最小化
- third-party Actions は full commit SHA で pin し、コメントに release tag
- checkout の `persist-credentials: false`
- 全 job に `timeout-minutes`
- PR の重複 run は `concurrency` で cancel
- install は `pnpm install --frozen-lockfile`
- release job では cache を使わない
- fork PR へ write permission や secret を渡さない
- `pull_request_target` で fork のコードを実行しない
- shell script は `set -euo pipefail` 相当、または Node script に寄せる
- CI config 自体を zizmor で検査

### 5.2 必須 workflow

| Workflow / job | trigger | 内容 |
|---|---|---|
| `ci/static` | PR、main | format、lint、typecheck、API report、docs |
| `ci/test` | PR、main | Node 最小版と Node 24 の unit/integration + coverage |
| `ci/package` | PR、main | build、publint、attw、tarball smoke |
| `ci/platform-smoke` | PR または main | Ubuntu、macOS、Windows で package import/CLI |
| `dependency-review` | PR | 新規依存の脆弱性と license |
| `codeql` | PR、push、schedule | JavaScript/TypeScript security analysis |
| `security-audit` | weekly、manual | production dependency の audit |
| `scorecard` | weekly、manual | OpenSSF Scorecard + SARIF |
| `release` | `v*` tag | version 検査、再検証、1回 build、attest、OIDC publish、GitHub Release |
| `check-pr-title` | PR | Conventional Commit 形式 |
| `label-pr` | PR | type による best-effort label |
| `typos` | PR、main | code/docs の typo |

platform matrix 全体で coverage を重複取得しません。最小 Node の Ubuntu job を coverage 正本にし、他は互換性の検査に絞ります。

---

## 6. 依存関係とサプライチェーン

### 6.1 pnpm

`pnpm-workspace.yaml` には少なくとも次の方針を持たせます。

```yaml
pmOnFail: download
minimumReleaseAge: 10080
minimumReleaseAgeStrict: true
minimumReleaseAgeIgnoreMissingTime: false
trustPolicy: no-downgrade
trustLockfile: false
blockExoticSubdeps: true
strictPeerDependencies: true
strictDepBuilds: true
allowBuilds:
  lefthook: true
```

- `minimumReleaseAge: 10080` は7日。緊急 security fix は exact version を `minimumReleaseAgeExclude` に追加し、PR に根拠を記録
- `devEngines.packageManager` の互換 range に従い、lockfile で解決した pnpm を `pmOnFail: download` で再現
- registry metadata に publish time がなければ fail closed
- provenance/trusted publisher の水準が過去版より下がった依存を拒否
- contributor が弱い policy で作った lockfile を盲信しない
- transitive dependency の git/tarball 取得を拒否
- install script は package ごとに明示承認
- `dangerouslyAllowAllBuilds` は禁止
- `pnpm-lock.yaml` は generated file。手編集禁止
- 依存変更と lockfile を同じ commit に含める

Lefthook の lifecycle script を許可するのは、Git hook 導入という目的をレビューした上での限定例外です。allowlist へ新しい package を足す変更は security-sensitive として扱います。

### 6.2 依存追加の審査

runtime dependency の追加 PR は次を記録します。

- 自作または標準 API で代替できない理由
- maintainer と release の継続性
- license
- direct/transitive package 数
- install script、native binary、network access の有無
- unpacked size と bundle への影響
- 対応 Node.js と ESM/CJS
- security advisory と provenance
- dependency / peerDependency / optionalDependency の選択理由

runtime dependency は library 側で exact pin せず、互換性を検証した SemVer range を宣言します。再現可能性は lockfile が担保します。dev dependency は Renovate/Dependabot の PR と lockfile で制御します。

### 6.3 自動更新

- Dependabot は npm と GitHub Actions を週次更新
- update PR に7日の cooldown
- patch/minor は関連 group にまとめ、major は分離
- major update は migration note と互換性検証なしに自動 merge しない
- security update は cooldown を上書き可能だが、人間が差分を確認
- Actions の SHA は Dependabot に更新させる

---

## 7. AI ネイティブ設計

### 7.1 正本と tool-specific layer

- `AGENTS.md`: 全エージェント共通の architecture、commands、quality、security、public API 規約
- `CLAUDE.md`: `AGENTS.md` を参照し、Claude Code 固有事項だけを追加
- `.claude/rules/`: source、tests、docs、package metadata の path-scoped rule
- `.claude/settings.json`: ローカル build/lint/test のみ allow
- commit、push、PR、publish は常に人間の許可対象

`AGENTS.md` に lint rule を全文転記しません。機械で強制できるものは config を正本にし、文書は設計理由と判断基準を説明します。

### 7.2 hook

| hook | 動作 |
|---|---|
| post-edit format | 編集した対象ファイルだけ Prettier/ESLint autofix。失敗を表示 |
| stop check | TS/package config 変更時に `pnpm check:quick`。再帰 loop を防ぐ |
| guard | protected file と危険な Git command を tool 実行前に拒否 |

guard の対象:

- `pnpm-lock.yaml` の直接編集
- `.env*`（`.example` 等を除く）と `secrets/**` の read/write
- `npmrc` の auth token、private key、credential の書き込み
- `git commit --no-verify`
- `git push --force`（`--force-with-lease` は人間承認の上で許容）
- `npm publish`、`pnpm publish`、release workflow dispatch
- security gate の削除、coverage threshold の引き下げ

hook は補助線であり、CI と branch protection の代替ではありません。

### 7.3 エージェント向けエラー

script は次を満たす error を返します。

- 何が失敗したか
- 対象 path / export / profile
- 期待値と実測値
- 次に実行すべき安全な修正コマンド
- error code
- secret や絶対 home path を含まない

tarball size 超過を例にすると、単に exit 1 ではなく、上限、実測、増加した上位ファイルを示します。

---

## 8. `uv-template` からの移植対応

| `uv-template` | TypeScript テンプレート | 方針 |
|---|---|---|
| `pyproject.toml` | `package.json` + `tsconfig*.json` + tool configs | 1ファイルへの集約を無理に再現しない |
| `uv.lock` | `pnpm-lock.yaml` | generated、手編集禁止 |
| `tool.uv.exclude-newer` | pnpm `minimumReleaseAge` | 固定日ではなく相対7日 |
| Ruff | ESLint typed lint + Prettier | 検出と整形を分離 |
| mypy strict | TypeScript strict + typed lint | strictness を初日から有効 |
| pytest + coverage | Vitest + V8 coverage | branch 80% floor |
| hatch build | `tsc` | ESM + declarations |
| wheel smoke test | tarball consumer smoke | runtime と型解決の複数 consumer を検査 |
| `__init__.__all__` | `src/index.ts` + `exports` | public API を明示 |
| MkDocs/mkdocstrings | TypeDoc + Markdown | public export の docs |
| pre-commit | Lefthook | Node ecosystem 内で完結 |
| pip-audit | package audit + dependency review | PR と定期実行 |
| trusted PyPI publish | npm trusted publishing | OIDC、tokenless |
| bootstrap.py | bootstrap.mjs | tracked files、placeholder、profile を決定論的変換 |
| `.claude/` hooks/rules | `.claude/` hooks/rules | TypeScript 用に移植 |
| `just` | package scripts | 追加 task runner を不要にする |

### 完了条件

1. 上表の各行に実ファイルまたは明示的な「不採用理由」がある
2. AI hook が正常系と拒否系の fixture test を持つ
3. 同じ変更に対して local hook、`pnpm check:quick`、CI の結果が矛盾しない
4. guard を bypass しなくても通常開発が完結する
5. dependency install が未承認 lifecycle script を検出すると失敗する
