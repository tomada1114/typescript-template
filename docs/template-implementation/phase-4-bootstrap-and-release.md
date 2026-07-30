# Phase 4: bootstrap and release rehearsal

> **前提**: Phase 3 完了（AGENTS.md / rules / hooks / Lefthook が揃い、fixture test が green）。
> 開始前に [README.md](README.md) と [decisions.md](decisions.md) を読むこと。

## 完了条件（仕様 03 §5）

> Definition of Done をすべて満たし、`zukai` の空リポジトリ生成に成功する。

**最も重い Phase です。** 分量が多いので、下の「推奨サブステップ」の単位で区切って進めてください。

---

## セッション開始プロンプト

```
このリポジトリの Phase 4（bootstrap and release rehearsal）を実装してください。

まず次を全文読む:
1. docs/template-implementation/README.md
2. docs/template-implementation/decisions.md   ← 検証済みの版・設計判断。再調査・再設計しない
3. docs/template-implementation/phase-4-bootstrap-and-release.md（この文書）
4. docs/template-requirements/03-bootstrap-release-and-dod.md 全文
5. docs/template-requirements/README.md §5（全体の完了条件15項目）
6. docs/template-requirements/01-repository-design.md §8（ドキュメントとメタデータ）
7. 参考（移植元）:
   /Users/masuyama/ghq/github.com/tomada1114/uv-template/scripts/bootstrap.py
   /Users/masuyama/ghq/github.com/tomada1114/uv-template/tests/test_bootstrap.py
   /Users/masuyama/ghq/github.com/tomada1114/uv-template/CONTRIBUTING.md, SECURITY.md,
   CODE_OF_CONDUCT.md, CHANGELOG.md, LICENSE, .github/ISSUE_TEMPLATE/, PULL_REQUEST_TEMPLATE.md

bootstrap.py の構造は流用するが、単純な全文置換で終わらせない。
JSON/YAML の構造を壊さないことと profile 差分の適用を追加要件とする（仕様 03 §1.4）。

このフェーズは分量が多いので、この文書の「推奨サブステップ」の単位で区切り、
各サブステップ完了時に completed / remaining を報告する。

禁止:
- 実 npm publish、GitHub repository 設定の変更、push、PR 作成、workflow dispatch
- test の skip/disable、assertion の弱体化、coverage 80% 閾値の引き下げ
- 型エラーや lint の抑制、security gate の削除、pnpm-lock.yaml の手編集
- zukai 固有の実装（Playwright / Iconify / MCP / 画像 golden test）を template に入れる

完了時に、この文書の「検証」節をすべて実行し、command / summary / exit code を示すこと。
```

---

## 推奨サブステップ

1. **community 文書**（LICENSE / CoC / CONTRIBUTING / SECURITY / CHANGELOG / README / templates）
2. **Changesets**（`.changeset/config.json` + README）
3. **release workflow**（OIDC / tag 照合 / 単一 tarball / attestation）
4. **bootstrap**（`scripts/bootstrap.mjs` + `tests/bootstrap.test.ts` + fixtures）
5. **生成 E2E**（3 profile + `zukai`）
6. **publish rehearsal と maintainer checklist**

---

## 1. OSS 文書（仕様 03 §2、DoD J）

### ほぼそのまま移植

`.editorconfig` / `.gitattributes` / LICENSE / `CODE_OF_CONDUCT.md` /
Issue template・PR template の構造 / SECURITY.md の private report 方針。
（`.editorconfig` と `.gitattributes` は Phase 0 で TypeScript 向けに済み）

### TypeScript/npm 向けに書き換えて移植

| ファイル                                                         | 要件                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                                      | 30秒で価値・install・最小例・互換性・API 入口が分かる（仕様 01 §8）。**最小例は実行可能**であること。badge / link は実在先を指す                                                                                                                                                               |
| `CONTRIBUTING.md`                                                | setup（`corepack` + `pnpm install --frozen-lockfile` + `pnpm hooks:install`）、主要コマンド、テスト、Changeset、PR 手順、**0.x 期間の breaking change policy**（仕様 03 §3.2）、**release partial failure の再実行手順**（仕様 03 §3.5）、最小 Node 検証時の `--config.runtime-on-fail=ignore` |
| `CHANGELOG.md`                                                   | Keep a Changelog + SemVer。Changesets が追記する形に合わせる                                                                                                                                                                                                                                   |
| `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml` | `config.yml` は blank issue を無効化し、security 報告を GitHub Security Advisories へ誘導                                                                                                                                                                                                      |
| `.github/PULL_REQUEST_TEMPLATE.md`                               | チェックリストは `pnpm check` / Changeset / API report / docs 更新                                                                                                                                                                                                                             |
| `docs/getting-started.md`, `docs/reference.md`                   | public API と同期。`docs/api/` は TypeDoc 生成なので tracked にしない                                                                                                                                                                                                                          |

**LICENSE の SPDX と `package.json.license` を一致させる**こと。

> ⚠ `README.md` は現在「テンプレート実装中」の内容です。placeholder package の README に
> 書き換え、テンプレート利用者向けの「Use this template → bootstrap」節を含めてください。
> bootstrap がその節を削除するのか残すのかを決め、テストで固定すること。

---

## 2. Changesets（仕様 03 §3.2、DoD H）

- `.changeset/config.json` + `.changeset/README.md`
- `changelog`、`commit: false`、`access: "public"`、`baseBranch: "main"` を明示
- **publish credential を Changesets action に渡さない**。Changesets は
  version/changelog PR の作成にのみ使う
- consumer-visible な変更は通常の Changeset、docs / test / CI / tooling
  だけの変更は `pnpm changeset --empty` で release intent を明示する
- PR CI の `changeset status --since=main` で記録漏れを fail させる
  （Changesets 自身の version PR は消費済みなので対象外）

---

## 3. release workflow（仕様 03 §3.3〜3.5、DoD H）

`.github/workflows/release.yml`、trigger は `v*` tag。フローは仕様 03 §3.3 のとおり:

```
tag == package.json.version を検査   ← publish 前に fail させる
frozen install（cache なし）
check:source で source gate + build を1回
未公開なら pnpm pack → tarball を1回だけ生成
公開済みの再実行なら npm registry から元 tarball を回収
package:verify で同一 tarball に publint / attw / consumer smoke
build provenance attestation
npm publish <exact-file>.tgz --access public   ← OIDC
同じ tgz を GitHub Release へ添付
```

必須条件（仕様 03 §3.4）:

- GitHub-hosted runner、Node.js 24、npm CLI 11.5.1 以上
- publish job の permission は `contents: read` と `id-token: write` **のみ**
- GitHub Environment `release`（required reviewer は人間が設定）
- `NPM_TOKEN` を置かない。trusted publishing 確認後は token publish を禁止
- public repo / public package では自動 provenance を有効のまま使う
- wrapper で認証方式や publish 対象を曖昧にせず、`npm publish dist/<exact-file>.tgz` を直接呼ぶ

失敗時（仕様 03 §3.5）:

- publish 成功後に GitHub Release が失敗しても**同じ version を再 publish しない**。
  registry 上の version を確認し、既発行なら GitHub Release の修復だけを許可する
- `unpublish` を通常の rollback にしない

`tests/workflows.test.ts`（Phase 2）に release workflow 用の assert を追加する:

- publish job の `permissions` が `contents: read` + `id-token: write` だけ
- `environment: release` がある
- `secrets.NPM_TOKEN` を参照していない
- tag/version 照合 step が publish step より前にある
- release 系 job で cache を有効にしていない

---

## 4. bootstrap（仕様 03 §1、DoD A）

### CLI

```bash
node scripts/bootstrap.mjs my-package \
  --profile node-library \
  --author "Jane Doe" \
  --email jane@example.com \
  --github-user janedoe \
  --license MIT \
  [--bin-name my-cli] \
  [--description "..."] \
  [--dry-run]
```

### 責務（仕様 03 §1.2）

- npm package 名の validation（scope、lowercase、許可文字、reserved name、長さ）
- profile の validation（`node-library` / `node-cli` / `universal-library`）
- package 名から**安全な identifier / API report 名 / tarball 名**を導出
  （`@acme/widgets` → unscoped `widgets`、tarball `acme-widgets`）
- placeholder 置換（`my-package` / `your-name` / `Your Name` / `you@example.com` /
  `A short description.`。一覧は decisions.md §2）
- node-cli profile の `bin` / `src/cli.ts` / `src/bin.ts` / CLI test を有効化
- 他 profile の不要ファイルと依存を削除
- public export / docs / badge / workflow / trusted publisher 手順を同期
- `devEngines.packageManager` / `.node-version` / CI matrix の整合
- `devEngines.packageManager` の互換 range と lockfile 上の解決版を検査
- profile 変更後に `pnpm install --lockfile-only` で lockfile を正規生成
- 残存 placeholder の全件検査
- 次に必要な手作業を具体的に表示

### profile 差分の適用（decisions.md §10 が正本）

| 項目                                            | node-library                          | node-cli             | universal-library                       |
| ----------------------------------------------- | ------------------------------------- | -------------------- | --------------------------------------- |
| `src/cli.ts`, `src/bin.ts`, `tests/cli.test.ts` | 削除                                  | 保持                 | 削除                                    |
| `package.json` の `bin`                         | 削除                                  | 保持（`--bin-name`） | 削除                                    |
| `sideEffects`                                   | `false`                               | `["./dist/bin.js"]`  | `false`                                 |
| `tsconfig.build.json` の `types`                | `["node"]`                            | `["node"]`           | **`[]`**                                |
| `tsconfig.build.json` の `lib`                  | 既定                                  | 既定                 | ES + DOM の必要最小限                   |
| `engines.node`                                  | `>=22.14`                             | `>=22.14`            | 原則記載しない                          |
| `@types/node`                                   | devDep に保持（tests/scripts が使う） | 同左                 | 同左（**src での使用は build が禁止**） |
| smoke consumer                                  | Node ESM                              | Node ESM + CLI       | Node ESM + bundler                      |

`tsconfig.build.json` の `types: []` にすると `eslint.config.mjs` が自動で
`node:*` の `no-restricted-imports` を追加します（Phase 0 実装済み）。
**profile フラグを別途持たせないこと。**

### 安全要件（仕様 03 §1.3）

- Git repository 内では **tracked files だけ**を変換
- Git repository でない場合は `node_modules` / `dist` / coverage / cache / `.git` / `.env*` を除外
- binary file は変更しない
- destination が既に存在する rename は拒否
- 同じ引数で2回実行しても破壊しない（完了済みなら明確に拒否または no-op）
- package 名を shell command に連結しない
- symlink の参照先へ意図せず書き込まない
- **一時コピー上で変換と lockfile 生成を成功させてから反映**する（途中失敗で半端な状態を残さない）
- `--dry-run` で変更予定を表示（**何も変更しない**）
- 変更ファイル一覧と次コマンドを最後に表示

### 生成先から削除するもの

- `docs/template-requirements/`（要件4文書）
- `docs/template-implementation/`（**このディレクトリ**）
- テンプレート固有の README 節（「Use this template」など）

### `tests/bootstrap.test.ts`（仕様 03 §1.4）

一時ディレクトリへ tracked files を複製し、各 profile で:

- 正常な unscoped / scoped package 名
- 不正名、空値、path traversal（`../evil`）、既存 destination
- optional metadata の省略
- placeholder がゼロ
- 不要 profile file / dependency がゼロ
- package metadata / README / API report 名 / workflow の名前が一致
- binary / fixture が変更されない（`tests/fixtures/` に binary を1つ置く）
- git なし fallback walk
- Windows path separator
- `--dry-run` が無変更
- 再実行が安全
- bootstrap 後の `pnpm install --frozen-lockfile` と `pnpm check`（重いので
  E2E テストとして分離してよいが、**スキップはしない**）

---

## 5. 生成 E2E（仕様 README §5 の 1, 15、DoD A）

3 profile それぞれで、**repo 外の一時ディレクトリ**に生成 → frozen install → full check。

```bash
WORK="$(mktemp -d)"
for profile in node-library node-cli universal-library; do
  DEST="$WORK/$profile"
  mkdir -p "$DEST"
  git -C . ls-files -z | while IFS= read -r -d '' f; do
    mkdir -p "$DEST/$(dirname "$f")"; cp "$f" "$DEST/$f"
  done
  ( cd "$DEST" && git init -q && git add -A \
    && node scripts/bootstrap.mjs "acme-$profile" --profile "$profile" \
         --author "Ada Lovelace" --email ada@example.com --github-user ada --license MIT \
    && pn24 install --frozen-lockfile && pn24 run check )
done
rm -rf "$WORK"
```

> ⚠ 上は流れの説明です。**この手順自体を `tests/` 側のテストか
> `scripts/` の検証用スクリプトとして実装**し、成功・失敗いずれでも一時ディレクトリを
> 削除してください（repo 内に残さない）。

### `zukai` 生成（仕様 03 §7）

`node-cli` profile で一時ディレクトリに `zukai` を生成し、`pnpm check` が green になることだけを
確認します。**製品固有コードは入れません。** 生成直後の runtime dependency がゼロであることも確認。

---

## 6. publish rehearsal と maintainer checklist

### ローカル publish rehearsal（仕様 README §5 の 14）

実 publish はしません。次のいずれかで代替し、**どれを選んだかを報告**してください。

- ローカル registry（`verdaccio` 等）を一時起動し、生成した検証用パッケージを publish → install → import
- または packed tarball に対する `npm publish --dry-run` 相当の検査 + tarball smoke の結果を証跡にする

いずれの場合も「registry に載った tarball を consumer が取得して import できる」ことを
示す形にしてください。

### `docs/maintainer-checklist.md`（仕様 03 §4）

コード外で人間が行う設定を checklist にします。

- main branch protection / required PR / required CI checks / conversation resolution
- force-push・delete 禁止 / linear history または merge 方針
- secret scanning と push protection
- Dependabot alerts / security updates
- private vulnerability reporting
- CodeQL
- GitHub Actions に Changesets version PR の作成を許可
- GitHub Environment `release` と required reviewer
- npm trusted publisher（repository と workflow filename を登録、`repository.url` を完全一致）
- npm account 2FA
- tag protection / immutable release の検討
- Codecov を使う場合の token と fork PR 方針
- OpenSSF Scorecard は public repository でのみ必須

### `scripts/check-repo-settings.mjs`（仕様 03 §4 末尾）

screenshot ではなく **`gh api` の read-only check で drift を検出**します。

- `gh` が無い / 未認証 / remote が無い場合は**明確なエラーで fail closed**
- required checks / approving review / conversation resolution / linear
  history / force-push・delete 禁止を確認
- secret scanning、vulnerability reporting、Actions の PR 作成権限、
  release environment の human reviewer を確認
- 差異は「何が期待値で何が実測か」の形で出力する

---

## 検証

```bash
# 既存 gate（両 Node、クリーン環境）
rm -rf node_modules && pn24 install --frozen-lockfile && pn24 run check
rm -rf node_modules && pn22 install --frozen-lockfile && pn22 run check

# bootstrap の全ケース
pn24 run test

# 3 profile 生成 E2E（実装した検証スクリプト / テスト経由で）
# node-cli profile での zukai 生成 → pnpm check

# workflow 検査
mise exec actionlint -- actionlint .github/workflows/

# 最終状態
git status --short
```

期待: すべて exit 0。`git status --short` に生成物・一時ディレクトリが残らない。
このリポジトリでは**コミットしない**。作業ツリーに残し、人間がレビューしてコミットする。

---

## DoD 対応

| DoD | 項目                                                                  | 対応                                     |
| --- | --------------------------------------------------------------------- | ---------------------------------------- |
| A   | 3 profile の責務と差分が文書化されている                              | `AGENTS.md` / `CONTRIBUTING.md` / この表 |
| A   | 生成後に他 profile の不要ファイル・依存が残らない                     | bootstrap + テスト                       |
| A   | package 名 / scope / bin 名 / owner / author / license を変更できる   | bootstrap CLI                            |
| A   | dry-run / validation / 残存 placeholder 検査                          | bootstrap                                |
| A   | 正常系・異常系・再実行・git なしをテスト                              | `tests/bootstrap.test.ts`                |
| A   | 新規生成物に placeholder が残らない                                   | placeholder 全件検査                     |
| A   | template 自身と生成物の両方で CI が通る                               | 生成 E2E + Phase 2 の CI                 |
| H   | Changeset で SemVer intent を review                                  | `.changeset/` + CONTRIBUTING             |
| H   | tag と package version を publish 前に照合                            | `release.yml` + 構造テスト               |
| H   | tarball を一度だけ生成し、同一 tarball を npm と Release に使う       | `release.yml`                            |
| H   | trusted publishing + OIDC / 長寿命 token なし / protected environment | `release.yml` + checklist                |
| H   | provenance attestation                                                | `release.yml`                            |
| H   | partial failure の再実行手順                                          | `CONTRIBUTING.md`                        |
| J   | README の最小例が実行可能                                             | README + CI で compile/実行              |
| J   | CONTRIBUTING の setup がクリーン環境で再現可能                        | `rm -rf node_modules` からの検証         |
| J   | SECURITY / LICENSE / CoC / Issue・PR templates                        | 各ファイル                               |
| J   | CHANGELOG と GitHub Release が同期                                    | Changesets + `.github/release.yml`       |
| J   | package metadata と badge/link が実在先を指す                         | bootstrap の同期 + テスト                |
| J   | docs/example が public API と同期                                     | TypeDoc + docs テスト                    |
| J   | Scorecard の指摘を確認し、未対応は理由を記録                          | `docs/maintainer-checklist.md`           |

---

## やらないこと

- `zukai` 固有の実装。生成した `zukai` は `pnpm check` が green になることだけ確認し、
  `playwright-core` / Iconify / MCP / 画像 golden test は入れない（仕様 03 §7）
- 実 npm publish、GitHub repository 設定の変更、push、PR 作成、workflow dispatch
- bundler（`tsdown` 等）の導入。仕様 01 §5 の導入条件を満たしていない
- 2つ目のパッケージが必要になるまで workspace / monorepo 化しない（仕様 README §2）

---

## 最終確認（仕様 README §5 の15項目）

Phase 4 完了時に、README §5 の15項目すべてについて
「実装済み＋fresh な検証結果」または「外部サービス上で人間が行う設定＋ローカル proxy 検証と手順」
を対応付け、**未説明の未達を0件**にしてください。

延期する項目があれば、issue・理由・期限・受け入れるリスクを記録します
（「後で対応」として黙って残さない）。
