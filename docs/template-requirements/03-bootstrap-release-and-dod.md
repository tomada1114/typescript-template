# 03. bootstrap・release・詳細 Definition of Done

## 0. 空のリポジトリからテンプレート開発を始める

この4文書は完成済み template のファイル一式ではなく、template repository を実装するための仕様です。したがって、空の repository へ文書だけを置いても、まだ開発環境は完成しません。

推奨する開始順序:

1. 空の Git repository を作る
2. Node.js 24 を選ぶ。nvm を使っている場合は `nvm install 24`、`nvm use 24`
3. pnpm 11 を公式手順で用意し、`pnpm --version` で確認
4. `pnpm init --bare --init-type module --init-package-manager` で最小 ESM package を作る
5. 本文書群4ファイルを `docs/template-requirements/` へコピーし、実装中の仕様・checklist として保持
6. [Template Phase 0](#template-phase-0-package-contract)から順に実ファイルを追加

`npm init` でも `package.json` は作れますが、この template は pnpm 11 の `devEngines.packageManager` と lockfile policy を使うため、最初から `pnpm init` を使います。

`create-vite`、`tsup init`、framework generator は使いません。Web application や bundler の前提が入り、汎用 npm package template の基準から外れるためです。

文書を repository にコピーせず、`zenn-content` 側を参照しながら実装しても構いません。ただし実装 PR と Definition of Done の対応を追いやすいため、template repository にコピーする方法を推奨します。

---

## 1. テンプレート初期化

### 1.1 利用方法

テンプレートを GitHub の「Use this template」で複製した後、依存を入れる前に bootstrap を実行します。

```bash
node scripts/bootstrap.mjs my-package \
  --profile node-library \
  --author "Jane Doe" \
  --email jane@example.com \
  --github-user janedoe \
  --license MIT
```

`zukai` では `--profile node-cli` を選びます。正式 package 名と CLI 名が異なる場合は `--bin-name` を明示します。

### 1.2 bootstrap の責務

- npm package 名の validation（scope、lowercase、許可文字、reserved name）
- profile の validation
- package 名から安全な identifier、API report 名、tarball 名を導出
- package、author、GitHub、description、license の placeholder 置換
- Node CLI profile の `bin`、`src/cli.ts`、CLI test を有効化
- 他 profile の不要ファイルと依存を削除
- public export、docs、badge、workflow、trusted publisher 手順を同期
- `devEngines.packageManager`、`.node-version`、CI matrix の整合
- `devEngines.packageManager` の互換 range と lockfile 上の解決版を検査
- profile 変更後に `pnpm install --lockfile-only` を実行し、lockfile を正規生成
- 残存 placeholder の全件検査
- 次に必要な手作業を具体的に表示

### 1.3 安全要件

- Git repository 内では tracked files だけを変換
- Git repository でない場合は `node_modules`、`dist`、coverage、cache、`.git`、`.env*` を除外
- binary file は変更しない
- destination が既に存在する rename は拒否
- 同じ引数で2回実行しても破壊しない。完了済みなら明確に拒否または no-op
- package 名を shell command に連結しない
- symlink の参照先へ意図せず書き込まない
- 途中失敗で半端な状態を残さないよう、事前検証と一時コピー上の変換・lockfile 生成が成功してから反映
- `--dry-run` で変更予定を表示
- 変更ファイル一覧と次コマンドを最後に表示

### 1.4 bootstrap のテスト

一時ディレクトリへテンプレートの tracked files を複製し、各 profile で次を検査します。

- 正常な unscoped/scoped package 名
- 不正名、空値、path traversal、既存 destination
- optional metadata の省略
- placeholder がゼロ
- 不要 profile file/dependency がゼロ
- package metadata、README、API report、workflow の名前が一致
- binary/fixture が変更されない
- git なし fallback walk
- Windows path separator
- dry-run が無変更
- 再実行が安全
- bootstrap 後の `pnpm install --frozen-lockfile`、`pnpm check`

`uv-template/scripts/bootstrap.py` と `tests/test_bootstrap.py` は構造を積極的に流用します。ただし単純な全文置換だけにせず、JSON/YAML の構造を壊さないことと profile 差分を追加要件にします。

---

## 2. OSS リポジトリとして必要なファイル

### ほぼそのまま移植

- `.editorconfig`
- `.gitattributes`
- LICENSE
- CODE_OF_CONDUCT.md
- Issue template / PR template の構造
- SECURITY.md の private report 方針
- Dependabot の GitHub Actions 更新
- OpenSSF Scorecard、dependency review、PR title check の考え方

### TypeScript/npm 向けに書き換えて移植

- README
- CONTRIBUTING
- CHANGELOG
- AGENTS.md / CLAUDE.md
- `.claude/rules/` と hooks
- `.devcontainer/devcontainer.json`
- CI / release / audit workflow
- bootstrap と smoke test
- `.gitignore`
- package manager cooldown

### コピーしない

- Python source/tests
- `pyproject.toml`、`uv.lock`
- Ruff、mypy、pytest、hatchling、MkDocs 固有設定
- Python 用 pre-commit 設定
- `justfile` の Python command

コピー後に Python 固有語が残っていないことを `rg` で検査します。

---

## 3. 変更と release の流れ

### 3.1 通常 PR

1. feature/fix branch を作る
2. 実装、テスト、docs、API report を更新
3. publish 対象変更なら Changeset を追加
4. `pnpm check`
5. Conventional Commit 形式の PR title
6. CI、dependency review、review を通す
7. main へ merge

docs、test、CI だけの変更は Changeset を必須にしません。package consumer に見える変更かどうかを基準にします。

### 3.2 Changeset

- patch/minor/major を PR 作成者が宣言
- summary は利用者視点
- breaking change は migration を含む
- API report の破壊的差分と major Changeset の不一致を review
- 0.x 期間の breaking change policy を CONTRIBUTING に明記
- Changesets action は version/changelog PR の作成に使う
- publish credential は Changesets action に渡さない

### 3.3 publish

`uv-template` と同じく、成果物を一度だけ build し、その同じ成果物を検査・公開・GitHub Release 添付に使います。

```
review 済み version PR
  ↓ merge
package.json / CHANGELOG 更新
  ↓ maintainer が vX.Y.Z tag
release workflow
  ├─ tag == package.json.version を検査
  ├─ frozen install（cache なし）
  ├─ pnpm check
  ├─ pnpm pack → dist/*.tgz（1回だけ生成）
  ├─ tarball smoke test
  ├─ build provenance attestation
  ├─ npm publish dist/*.tgz（OIDC）
  └─ 同じ tgz を GitHub Release へ添付
```

### 3.4 npm trusted publishing

- GitHub-hosted runner
- npm CLI 11.5.1 以上
- Node.js 22.14.0 以上。release は Node.js 24
- job permission は `contents: read` と `id-token: write`
- npmjs.com で repository と workflow filename を trusted publisher に登録
- `repository.url` を完全一致
- GitHub Environment `release` に required reviewer
- `NPM_TOKEN` を置かない
- trusted publishing 確認後、traditional token publish を禁止
- public repository/public package では自動 provenance を有効のまま使用
- publish 前に `npm publish --dry-run` 相当ではなく、生成済み tarball の検査結果を利用

release workflow は `npm publish dist/<exact-file>.tgz --access public` を直接呼びます。wrapper が認証方式や publish 対象を曖昧にしないようにするためです。

### 3.5 release 失敗時

- npm publish 成功後に GitHub Release が失敗しても、同じ version を再 publish しない
- workflow は registry 上の version を確認し、既発行なら GitHub Release の修復だけを許可
- tag/version 不一致は publish 前に fail
- partial failure の再実行手順を CONTRIBUTING に記載
- `unpublish` を通常の rollback として使わない。修正版を新 version で出す
- compromised release は security policy と npm の手順に従い deprecate/revoke を判断

---

## 4. GitHub repository 設定

コード外のため bootstrap だけでは完了しない設定を checklist にします。

- main branch protection
- required pull request
- required CI checks
- conversation resolution
- force-push/delete 禁止
- linear history または merge 方針
- secret scanning と push protection
- Dependabot alerts/security updates
- private vulnerability reporting
- CodeQL
- GitHub Environment `release` と required reviewer
- npm trusted publisher
- npm account 2FA
- tag protection / immutable release の検討
- Codecov を使う場合の token と fork PR 方針
- OpenSSF Scorecard は public repository でのみ必須

設定後の screenshot ではなく、可能なら `gh api` 等の read-only check script で drift を検出します。権限が必要な設定変更は自動実行せず、maintainer に手順を示します。

---

## 5. 実装ロードマップ

### Template Phase 0: package contract

- repository skeleton
- profile 定義
- package metadata と exports
- strict TypeScript
- `tsc` build
- ESLint、Prettier
- Vitest + coverage
- package scripts

**完了条件**: placeholder public API が build/test され、Node 最小版と Node 24 で `pnpm check:quick` が通る。

### Template Phase 1: publish artifact quality

- API Extractor
- publint、attw
- tarball allowlist/size inspection
- ESM/TypeScript consumer smoke
- CLI/universal profile smoke
- TypeDoc

**完了条件**: repository source を参照せず、tarball だけから runtime と型 consumer が成功する。

### Template Phase 2: CI and supply chain

- CI matrix
- dependency review、CodeQL、audit、Scorecard、zizmor、typos
- pnpm release age/trust/install script policy
- Dependabot
- SHA pin、permissions、timeout、concurrency

**完了条件**: fork PR を含む CI が最小権限で通り、危険な dependency/Actions 変更が gate される。

### Template Phase 3: AI-native workflow

- AGENTS.md
- path-scoped rules
- guard、format、stop hooks
- permission allowlist
- hook fixture tests

**完了条件**: 通常変更は高速に進められ、protected file と publish/Git bypass は決定論的に拒否される。

### Template Phase 4: bootstrap and release rehearsal

- profile-aware bootstrap
- community files
- Changesets
- OIDC release
- template generation E2E
- npm publish rehearsal

**完了条件**: 下記 Definition of Done をすべて満たし、`zukai` の空リポジトリ生成に成功する。

---

## 6. 詳細 Definition of Done

### A. テンプレートとしての再利用性

- [ ] 3 profile の責務と差分が文書化されている
- [ ] 生成後に他 profile の不要ファイル・依存が残らない
- [ ] package 名、scope、bin 名、owner、author、license を変更できる
- [ ] bootstrap は dry-run、validation、残存 placeholder 検査を持つ
- [ ] bootstrap の正常系・異常系・再実行・git なしをテストしている
- [ ] 新規生成物に `my-package`、`your-name` 等が残らない
- [ ] template 自身と生成物の両方で CI が通る

### B. package 契約

- [ ] ESM-only と profile の runtime contract が明示されている
- [ ] `exports`、`types`、`files` が allowlist
- [ ] root/public subpath 以外の deep import が拒否される
- [ ] default export と無差別 `export *` を使っていない
- [ ] public symbol に型注釈と必要な TSDoc がある
- [ ] API report が committed で、差分が review できる
- [ ] runtime dependency がゼロの placeholder から始まる

### C. 型・lint・format

- [ ] TypeScript strict と追加 strict option が有効
- [ ] source/tests/scripts/config を型検査する
- [ ] typed lint が有効で warning ゼロ
- [ ] unused suppression を拒否する
- [ ] Prettier の exact version と check がある
- [ ] `pnpm check` が非破壊

### D. テスト

- [ ] public behavior の正常・異常・境界を検査
- [ ] async cleanup、timeout、abort が該当時に検査される
- [ ] public API の型テストがある
- [ ] branch を含む coverage 80% floor
- [ ] test は順序、timezone、network、実時間 sleep に依存しない
- [ ] 単独 test 実行で coverage 全体 gate を強制しない

### E. build と tarball

- [ ] clean build で JS、`.d.ts`、map が生成される
- [ ] publint と attw が error ゼロ
- [ ] tarball の path、size、file count に gate がある
- [ ] secret/source/test/cache が tarball にない
- [ ] tarball install 後の ESM import が成功
- [ ] tarball install 後の consumer `tsc` が成功
- [ ] CLI profile の help/version/error/exit code が成功
- [ ] universal profile の bundler consumer が成功
- [ ] package smoke が repository source を import しない

### F. dependency と security

- [ ] lockfile が committed で frozen install を使用
- [ ] release age 7日と fail-closed policy
- [ ] provenance downgrade を拒否
- [ ] transitive exotic source を拒否
- [ ] lifecycle script が allowlist
- [ ] dependency review、audit、CodeQL、Scorecard がある
- [ ] Dependabot に cooldown と group 方針がある
- [ ] security report は public issue ではなく private 経路

### G. CI

- [ ] Node 最小版と Node 24
- [ ] Ubuntu と、package smoke の macOS/Windows
- [ ] permissions は job 最小単位
- [ ] Actions は SHA pin
- [ ] checkout credential を残さない
- [ ] timeout と concurrency
- [ ] fork PR へ secret/write permission を渡さない
- [ ] zizmor が workflow を検査

### H. release

- [ ] Changeset で SemVer intent を review
- [ ] tag と package version を publish 前に照合
- [ ] tarball を一度だけ生成
- [ ] 検査した同一 tarball を npm/GitHub Release に使用
- [ ] trusted publishing + OIDC
- [ ] 長寿命 `NPM_TOKEN` なし
- [ ] protected release environment
- [ ] provenance attestation
- [ ] partial failure の再実行手順

### I. AI ネイティブ

- [ ] `AGENTS.md` が正本
- [ ] tool-specific file は差分だけ
- [ ] path-scoped rules
- [ ] changed-file format hook
- [ ] quick stop gate
- [ ] lockfile/secret/Git bypass/publish guard
- [ ] hook の fixture test
- [ ] commit/push/PR/publish は permission allowlist 外

### J. OSS の見え方

- [ ] README の最小例が実行可能
- [ ] CONTRIBUTING の setup がクリーン環境で再現可能
- [ ] SECURITY、LICENSE、Code of Conduct、Issue/PR templates
- [ ] CHANGELOG と GitHub Release が同期
- [ ] package metadata と badge/link が実在先を指す
- [ ] docs/example が public API と同期
- [ ] OpenSSF Scorecard の指摘を確認し、未対応は理由を記録

---

## 7. `zukai` へ進む条件

次の条件を満たすまでは、`zukai` 方向性文書「05. 実装ロードマップ」の図解ツール Phase 0 を開始しません。

1. Template Phase 0〜4 が完了
2. `node-cli` profile の生成 E2E が green
3. 生成直後の runtime dependency はゼロ
4. `zukai` 用 package 名、CLI 名、license を決定
5. 生成物の `pnpm check` が green
6. generic template 側に Playwright、Iconify、MCP、画像 golden test が入っていない

その後、`zukai` 側で初めて `playwright-core` 等を追加し、`zukai` 方向性文書「04. アーキテクチャ」の `src/core/`、`src/renderers/`、`tokens/`、`templates/` を構築します。

generic template の改善が `zukai` 実装中に見つかった場合は、次の順で処理します。

1. package 固有か template 共通か分類
2. 共通なら template repository へ先に修正
3. template の generation E2E を通す
4. `zukai` へ同じ修正を backport

これにより、`zukai` を一度限りの高品質リポジトリにせず、次の TypeScript/npm プロジェクトでも再利用できる資産として残します。
