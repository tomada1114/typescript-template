# 検証済みの事実と決定事項

Phase 0 の実装中に**一次資料で確認した**内容と、そこから確定した設計です。
**同じ調査を繰り返さないでください。** ここに書かれた決定は再設計の対象外です。

調査日: **2026-07-29**。出典は `https://registry.npmjs.org/<pkg>`、`https://nodejs.org/dist/index.json`、
および各 CLI の `--help` / 実行結果です。

---

## 1. バージョン選定

### Node.js

| 用途                     | 版          | 根拠                                                                          |
| ------------------------ | ----------- | ----------------------------------------------------------------------------- |
| 開発 / CI 既定 / release | **24.18.1** | `nodejs.org/dist/index.json` で v24 系最新かつ `lts: "Krypton"`（Active LTS） |
| 最小サポート             | **22.14.0** | 仕様 T4。v22 系は `lts: "Jod"` で維持中                                       |

`.node-version` は `24`（メジャーのみ）。`devEngines.runtime.version` は `^24.0.0`。
`engines.node` は `>=22.14`（consumer 契約）。

### pnpm

**11.18.0**（registry の `dist-tags.latest`）。Corepack 経由で使用:

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 mise exec node@24.18.1 -- corepack pnpm@11.18.0 <args>
```

`pnpm-lock.yaml` には `packageManagerDependencies` として `pnpm@11.18.0` と `@pnpm/exe@11.18.0` が
記録されています（pnpm 11 の自己管理機能）。`devEngines.packageManager.onFail: "download"` と
`pnpm-workspace.yaml` の `pmOnFail: download` がこれを再現します。

### `packageManager` と `devEngines.packageManager` は同一文字列にする —— 仕様 01 §3 からの逸脱

仕様 01 §3 は `devEngines.packageManager.version` を `"^11.18.0"`（range）と書いていますが、
実装では **exact `"11.18.0"`** にしています。理由は 2 つあります。

1. トップレベルの `packageManager` フィールドが必要です。corepack と Dependabot は
   ここを読み、**exact semver でないと解決に失敗**します（range の
   `devEngines.packageManager` にフォールバックすると "semver version required" で
   Dependabot の pnpm 更新ジョブが落ちる）。
2. その `packageManager` と `devEngines.packageManager.version` の**文字列が食い違うと**、
   pnpm は毎コマンド `[WARN] "packageManager" and "devEngines.packageManager" specify
different versions of pnpm ... "packageManager" will be ignored` を出します。
   `pnpm check:quick` 1 回で 6 回出るため、テンプレートの初期状態としては不適切です。

exact にしても range の意図（lockfile が解決した pnpm を `pmOnFail: download` で再現する）は
損なわれません。より厳しくなるだけです。両者の一致は
`tests/workflows.test.ts` の "declares the same pnpm string in packageManager and devEngines" と
`scripts/bootstrap.mjs` の `regenerateLockfile()` が守ります。

なおこの `[WARN]` は、後述の `--config.runtime-on-fail=ignore` による package.json 書き戻しとは
**無関係**です。両方を exact に揃えても書き戻しは起きます（実測）。

### TypeScript は 6.0.3 —— 7.x を使わない

**これが最も重要な選定です。** registry の `dist-tags.latest` は **7.0.2** ですが、仕様が要求する
ツールチェーンと互換性がありません。

| package                            | typescript の peer range               | 実測                        |
| ---------------------------------- | -------------------------------------- | --------------------------- |
| `typescript-eslint@8.65.0`         | `>=4.8.4 <6.1.0`                       | **6.0.x が上限**            |
| `typedoc@0.28.20`                  | `5.0.x \|\| … \|\| 6.0.x`              | **6.0.x が上限**            |
| `@microsoft/api-extractor@7.58.12` | peer 宣言なし / TS **5.9.3 を bundle** | 6.0.3 の `.d.ts` 解析は成功 |

したがって **`"typescript": "~6.0.3"`** が上限です。`strictPeerDependencies: true` を有効にしているため、
7.x を入れると install 自体が失敗します。

API Extractor は実行時に次を出しますが、これは **warning で、exit 0 のまま正しく動作します**。
無視してよく、抑制の必要もありません。

```
*** The target project appears to use TypeScript 6.0.3 which is newer than
    the bundled compiler engine; consider upgrading API Extractor.
```

`tsc --version` → `Version 6.0.3` を確認済み。仕様 01 §4.1 の compilerOptions は
`isolatedDeclarations` を含めて全て TS 6.0.3 で有効です。

### `minimumReleaseAge: 10080`（7日）による解決版のずれは正常

`pnpm-workspace.yaml` の supply-chain cooldown が効くため、**最新版ではなく「7日以上経過した最新版」**が
解決されます。以下は install ログで確認した実測で、**バグではありません**。

| package       | registry latest     | 実際に解決された版        |
| ------------- | ------------------- | ------------------------- |
| `eslint`      | 10.8.0 (2026-07-24) | **10.7.0** (2026-07-10)   |
| `@types/node` | 26.1.2 (2026-07-27) | **26.1.1** (2026-07-08)   |
| `publint`     | 0.3.22 (2026-07-23) | **0.3.21** (2026-05-13)   |
| `typescript`  | 7.0.2               | **6.0.3**（range で上限） |

`prettier` だけは仕様 T10 に従い exact pin: **`"3.9.6"`**（2026-07-21 公開、7日超なので解決可能）。

依存追加時は「その版が7日以上経っているか」を確認してください。経っていない場合、`^` range なら
自動的に古い版に落ちますが、exact pin だと install が失敗します。

---

## 2. リポジトリ自身の package は placeholder（正本との差異報告）

**ベースラインとの差異**: 初期スキャフォールドの `package.json` は
`name: "typescript-template"` / `version: "0.0.0"` / `private: true` でしたが、
仕様 01 §3 が要求する placeholder package 契約に置き換えました。

```
name: "my-package", version: "0.1.0", private なし
author: "Your Name <you@example.com>"
repository.url: "git+https://github.com/your-name/my-package.git"
description: "A short description."
```

理由: テンプレート自身が `pnpm pack` → tarball 検査 → consumer smoke を回せないと DoD E を
満たせず、`private: true` では publint / attw / pack の検証ができません。
`uv-template` も同じ構造（repo 名 `uv-template`、package 名 `my-package`、URL は
`your-username/my-package`）で、この差異は**意図的**です。外部正本を優先しました。

### placeholder 一覧（Phase 4 の bootstrap が置換する）

| placeholder            | 意味                                                    |
| ---------------------- | ------------------------------------------------------- |
| `my-package`           | npm package 名（scope 付きも可）、bin 名、API report 名 |
| `your-name`            | GitHub owner                                            |
| `Your Name`            | author 名                                               |
| `you@example.com`      | author email                                            |
| `A short description.` | description                                             |

---

## 3. Node 22.14 では `devEngines.runtime` を明示的に外す必要がある

仕様 01 §3 の `devEngines.runtime` は `version: "^24.0.0"`, `onFail: "error"` です。
これは pnpm が**ハードエラー**にします。

```
[ERROR] This project requires Node.js ^24.0.0. Your current Node.js is v22.14.0
```

一方で DoD は「最小サポート Node でも `pnpm install --frozen-lockfile` と `pnpm check` が exit 0」を
要求します。両立させる方法は、**最小 Node での互換性検証時だけ**明示的に opt-out することです。

```bash
pnpm --config.runtime-on-fail=ignore run check
```

### 効かない書き方（実測）

| 書き方                                     | 結果                                        |
| ------------------------------------------ | ------------------------------------------- |
| `pnpm --runtime-on-fail=ignore …`          | `[ERROR] Unknown option: 'runtime-on-fail'` |
| `npm_config_runtime_on_fail=ignore pnpm …` | 無視され、エラーのまま                      |
| `pnpm --config.runtime-on-fail=ignore …`   | **動作する**                                |

`devEngines.runtime.onFail` を `warn` に緩めるのは仕様の設計変更なので**しません**。
開発既定を Node 24 に強制するガードは残したまま、互換性検証だけ opt-out します。
CI の最小 Node job でも同じフラグが必要です（Phase 2）。

### `pnpm install` は実効設定を package.json に書き戻す（実測）

`--config.runtime-on-fail=ignore` を付けた `pnpm install` は、その実効値を
`package.json` に**書き戻します**（`devEngines.runtime.onFail` が `"error"` →
`"ignore"` になる）。書き換わるのはこの 1 フィールドだけで、`pnpm-workspace.yaml`
と `pnpm-lock.yaml` は変わりません。

書き戻すのは `install` だけで、`pnpm run` は package.json を触りません。
`packageManager` と `devEngines.packageManager` のバージョン文字列を一致させても
書き戻しは止まりません（両方 `11.18.0` にして実測済み）。

したがって、このフラグ付きの install の直後には必ず `git restore package.json` を
置きます。置かないと、後続ステップが読む manifest が誰もコミットしていない内容に
なり、`tests/workflows.test.ts` と `tests/bootstrap.test.ts` の
`devEngines.runtime.onFail === "error"` アサーションが落ちます。CI の最小 Node job
と `scripts/bootstrap.mjs` の `regenerateLockfile()` は、どちらもこの復元を行います。

---

## 4. `attw --pack` は `devEngines` と非互換 —— tarball を渡す

`attw --pack .` は内部で **`npm pack` を実行**します。しかし `devEngines.packageManager.name` が
`pnpm` なので、npm は名前不一致で拒否します（実測）。

```
npm error code EBADDEVENGINES
npm error EBADDEVENGINES Invalid name "pnpm" does not match "npm" for "packageManager"
npm error EBADDEVENGINES   required: { name: 'pnpm', version: '^11.18.0', onFail: 'download' }
```

`attw --help` を確認した結果、**pack コマンドを差し替えるオプションは存在しません**
（`-P, --pack` は "Run `npm pack` in the specified directory" 固定）。

### 決定

`pnpm pack --pack-destination <dir>` で tarball を作り、その `.tgz` のパスを attw に渡します。
attw は `attw <file.tgz>` を受け付けます。副作用として、**publish される tarball そのものを
attw が検査する**ことになり、仕様の意図（成果物を検証する）にむしろ合致します。

`publint run <file.tgz> --strict` も既存 tarball を受け付けます。したがって
Phase 1 の artifact gate は次の形に統一します:

```
pnpm run build
  && pnpm pack --pack-destination .package
  && node scripts/verify-package.mjs --pack-dir .package
```

`verify-package.mjs` は同じ `.tgz` に publint / attw / consumer smoke を適用する。
release では `--tarball dist/package.tgz` を渡すため、検査後の rebuild / repack はない。

---

## 5. `.mjs` スクリプトから pnpm は呼べない

pnpm 11 の script 実行環境では **`npm_execpath` が `undefined`** です（実測）。
`npm_config_user_agent` は `pnpm/11.18.0 npm/? node/v24.18.1 darwin arm64` と入りますが、
実行パスは取れません。

### 決定

- **pack は `package.json` の script 側で `pnpm pack` する**（pnpm の版が保証される場所）。
- `.mjs` 側は `--pack-dir <dir>` / `--tarball <file>` を引数で受け取る。
- shell glob（`*.tgz`）は cmd.exe で展開されないので使わない。`.mjs` が
  ディレクトリを読んで「`.tgz` がちょうど1個」を検証する（仕様 02 §4 step 2 の
  「1個だけ生成」チェックを兼ねる）。
- consumer 側の install は **`npm install <tgz>`** でよい。consumer の `package.json` には
  `devEngines` が無いので EBADDEVENGINES は起きず、npm は Node に同梱なので追加ツール不要。

---

## 6. `.mjs` を型検査する（`allowJs` + `checkJs`）

DoD C が「source/tests/scripts/config を型検査する」を要求します。`scripts/*.mjs` と
`.claude/hooks/*.mjs` は install 前の素の Node で動く必要があるため `.ts` にできません。
そこで `tsconfig.json` に `allowJs: true` / `checkJs: true` を入れ、JSDoc で型を付けます。

- `tsconfig.json` の `include`: `["src", "tests", "scripts", ".claude/hooks", "*.ts", "*.mts", "*.mjs"]`
- `tsconfig.build.json` は逆に `allowJs: false` / `checkJs: false`（公開成果物は TS 出力のみ）

`JSON.parse` は `any` を返すので、`/** @type {unknown} */` で受けて narrowing してください
（typed lint の `no-unsafe-*` がそのまま効きます）。

---

## 7. `.mjs` では Node グローバルを明示 import する

`js.configs.recommended` の `no-undef` は JS ファイルに適用されるため、`console` や `process` を
そのまま使うと error になります。`globals` package を足す代わりに、**明示 import** を規約にしました。

```js
import console from "node:console";
import process from "node:process";
```

依存を増やさず、ESLint 設定に globals ブロックを追加する必要もありません。
`.ts` 側は typescript-eslint が `no-undef` を無効化するので不要です。

---

## 8. CLI と module を兼ねる `.mjs` の自動実行ガード

`scripts/*.mjs` はテストから import されるため、「直接実行されたときだけ CLI として動く」判定が必要です。
**`import.meta.url.endsWith("foo.mjs")` は import 時も true になるので使えません。**

`scripts/lib/is-main.mjs` に切り出し、`process.argv[1]` と `fileURLToPath(import.meta.url)` の
**realpath を比較**します（symlink 経由の `.bin` でも一致するため）。

`import.meta.main` は Node 24+ 専用で、最小サポートが 22.14 なので使えません。

---

## 9. ESLint 設定

- `tseslint.config()` は **typescript-eslint 8.65.0 で deprecated**（`no-deprecated` が検出）。
  ESLint core の `defineConfig` / `globalIgnores`（`eslint/config` から import）を使う。
- `noPropertyAccessFromIndexSignature`（tsconfig）と `@typescript-eslint/dot-notation`（lint）は
  `Record<string, unknown>` に対して**衝突する**。リテラルキーのブラケットアクセスは lint が嫌がるので、
  可変キーを取る小さなヘルパ（`readKey(value, key)`）経由で読む。
- global ignore は生成物だけ（`dist/`, `coverage/`, `docs/api/`）。設定ファイルや自動化スクリプトも lint 対象。
- `reportUnusedDisableDirectives: "error"`（不要になった disable を error）。
- `ban-ts-comment`: `ts-ignore` / `ts-nocheck` 禁止、`ts-expect-error` は10文字以上の説明付きのみ。
- `src/**` に `no-restricted-exports`（default export 禁止）と
  `no-restricted-syntax: ExportAllDeclaration`（`export *` 禁止）。
- `no-console` は既定 error。`src/cli.ts` / `src/bin.ts` と `scripts/**`, `.claude/hooks/**` でのみ off。

---

## 10. profile の記録場所は `tsconfig.build.json` の `types`

3 profile のうち `universal-library` だけが「src で Node 型を使えない」制約を持ちます。
これを **`tsconfig.build.json` の `compilerOptions.types: []`** で表現し、**そこを唯一の正本**にします。

- Node profile: `"types": ["node"]`
- universal profile: `"types": []` → `import … from "node:fs"` が build で hard error になる

`eslint.config.mjs` はこの値を読み戻して universal のときだけ `node:*` の
`no-restricted-imports` を追加します。profile フラグを別途持たないので、設定と実際にコンパイルできる
ものがずれません。Phase 1 の `smoke-package.mjs` も同じ判定で bundler consumer 検証を出し入れします。

### テンプレート自身の profile は `node-cli`

テンプレート本体は 3 profile の**上位集合**である `node-cli` として構成します
（`bin`、`src/cli.ts`、`src/bin.ts`、`tests/cli.test.ts` を持つ）。
bootstrap が profile に応じて削る方向に動きます。

`sideEffects` は `node-cli` では **`["./dist/bin.js"]`**（bin は実際に副作用を持つので `false` は嘘）。
library profile では `false`。

---

## 11. `src/bin.ts` は意図的に coverage 0%

`src/bin.ts` は `runCli` を実プロセスに束ねるだけの shim です。テスト可能なロジックは全て
`src/cli.ts` にあります。そのため bin.ts は unit coverage 0% ですが、

- 全体は Stmts 92.64 / Branch 88.23 / Funcs 84.21 / Lines 92.59 で閾値 80 を満たす
- Phase 1 の tarball smoke test が packed tarball 経由で bin を end-to-end 実行する

**coverage の exclude に追加しないでください。閾値も下げないでください。**
`vitest.config.ts` の `coverage.include: ["src/**/*.ts"]` により未テストファイルも 0% として
分母に入る設定です（消えない）。

---

## 12. API Extractor の前提（Phase 1 で必要）

実測で判明した必須条件:

1. **`etc/` ディレクトリが先に存在する必要がある**。無いと
   `Error: Unable to create the API report file. Please make sure the target folder exists`。
2. **すべての公開シンボルに release tag が必要**。無いと
   `(ae-missing-release-tag) "X" is part of the package's API, but it is missing a release tag`。
   → `src/errors.ts` / `src/identifier.ts` / `src/timeout.ts` の公開宣言に `@public` を付ける
   （Phase 0 に戻す際に一旦外してあります）。
3. `apiReport.reportFileName` は**指定しない**。既定で unscoped package 名になるので、
   bootstrap で package 名を変えると report 名も自動で追従する。
4. `apiReport.reportTempFolder` が `temp/` を作るので `.gitignore` に追加する。

生成された report は次のようになり、`src/internal/` が漏れていないことも同時に確認できます。

```ts
// @public
export class InvalidInputError extends Error { … }
// @public
export function normalizeIdentifier(input: string, options?: NormalizeIdentifierOptions): string;
// @public
export interface NormalizeIdentifierOptions { … }
// @public
export class TimeoutError extends Error { … }
// @public
export function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, options: WithTimeoutOptions): Promise<T>;
// @public
export interface WithTimeoutOptions { … }
```

---

## 13. lefthook の postinstall が `lefthook.yml` を上書き生成した

`pnpm install` 時に lefthook の postinstall が走り、

- `lefthook.yml` が無ければ**コメントだけの雛形を新規作成**する
- `.git/hooks` に hook を sync する

現在の `lefthook.yml` はこの**自動生成された雛形のまま**です。Phase 3 で実際の設定に置き換えてください。
`pnpm-workspace.yaml` の `allowBuilds.lefthook: true` は、この postinstall を通すための
**レビュー済みの限定例外**です（`strictDepBuilds: true` なので許可が無いと install が失敗する）。

---

## 14. Prettier

- `printWidth: 88`、`trailingComma: "all"`。
- `proseWrap` は既定（`preserve`）。`always` にすると Markdown が再流し込みされ、
  `docs/template-requirements/` の差分が読めなくなる。
- `.prettierignore` に `docs/template-requirements/`（外部正本の逐語コピー）、
  `pnpm-lock.yaml`、`CHANGELOG.md`（Changesets 生成）、`etc/*.api.md`（API Extractor 生成）。
- `tsconfig.json` は JSONC（コメント入り）だが Prettier は正しく整形する（実測）。
- Phase 0 では `pnpm run format` を一度かけて `format:check` を green にしてある。

---

## 15. テスト実装で踏んだ落とし穴

### 型テストは実行されてしまう

`tests/types.test.ts` で `@ts-expect-error` 付きの不正呼び出しを `it()` の直下に書くと、
**実行時にも呼ばれて** unhandled rejection になります。呼ばれない関数の中に閉じ込め、
その関数自体を assert してください。

```ts
it("rejects input that is not a string", () => {
  const rejected = (): void => {
    // @ts-expect-error a number is not a valid identifier source
    normalizeIdentifier(42);
  };
  expect(rejected).toBeTypeOf("function");
});
```

### union の narrowing は初期化子で潰れる

`const error: A | B = new B()` は宣言型ではなく初期化子で narrowing され、else 側が `never` に
なります。判別 union の型テストは**関数引数で受ける**こと。

### 到達不能な分岐を assert しようとしない

`normalizeIdentifier` は先頭が必ず英数字なので、`maxLength` による切り詰めで空文字列になる分岐は
**存在し得ません**。`allowUnreachableCode: false` の下で dead code を書かず、テスト側も
その前提（切り詰めても空にならない）を assert する形に直してあります。

---

## 16. 実環境メモ

当初のブリーフには「システム既定は Node 25.8.1 / pnpm 9.7.0」とありましたが、
実測は **Node v22.16.0（nvm）/ pnpm 10.12.1** でした。いずれにせよグローバル既定は使わず、
`mise` + `corepack` で固定しています。`mise` にはこの作業で
`node@22.14.0` と `node@24.18.1` を追加済み（**activate はしていない** =
グローバル既定は変更していない）。

`mise` には `actionlint 1.7.12` と `shellcheck 0.11.0` が既に入っています。
Phase 2 の workflow 検証でそのまま使えます。

---

## 17. rules を AGENTS.md に統合し、skills を Codex CLI にもブリッジ（2026-08-24 追記）

Phase 0〜9 の記述時点では path-scoped rules は Claude Code 専用の `.claude/rules/` に
置いていましたが、Codex CLI からは不可視という欠点があったため
`maintaining-agents-md` スキルの型に合わせて次のように移設しました
（hooks は対象外 — Claude Code 専用のまま `.claude/hooks/` に残る。§18 参照）。

- `.claude/rules/*.md` を廃止し、内容はルートの `AGENTS.md` に統合。`testing.md` の
  本体だけは分量が大きいため `tests/AGENTS.md` に置き、ルートの `## Testing` 節から
  参照する形にした。`CLAUDE.md`／`tests/CLAUDE.md` は `@AGENTS.md` を import するだけの
  stub。
- `.claude/skills/merge-dependabot` はそのまま Claude Code 専用スキルとして残し、
  `.agents/skills/merge-dependabot` から相対 symlink で Codex CLI にもブリッジしている。
  `scripts/bootstrap.mjs` の `copyFiles` はこの移設で初めてリポジトリに symlink が入り、
  シンボリックリンクを再コピーする際に `EEXIST` で失敗する既存バグを踏んだため、
  上書き前に `rmSync(destination, { force: true })` を挟むよう修正した。

---

## 18. `permissions.deny` を宣言的に整備し、gate ファイル判定の絶対パスバグを修正（2026-08-24 追記）

`.claude/hooks/guard.mjs` のヘッダーコメントには「permission `deny` ルールは一部の
Claude Code バージョンでは advisory」という誤記が残っていましたが、これは古い認識
（anthropics/claude-code#6699 由来）で、**現行 Claude Code では bypassPermissions を
含む全モードで `deny` はハード enforce される**。ただし公式ドキュメントは「引数を
制約する Bash パターンは fragile」と明言しており(`git commit` と `git commit
--no-verify` の区別、`&&` チェーンの読み解き、`sh -c '…'` のような wrapper の迂回は
できない)、これは今後も `guard.mjs` の役割として残る。

これを踏まえ `.claude/settings.json` の `permissions.deny` に、パスやコマンドの
完全一致で表現できるルール(lockfile 5 種の `Edit`、`npm`/`pnpm`/`yarn`/`bun` の
`publish`、`gh workflow run`、`gh release create`)を宣言的に追加した。あわせて、
`Edit(path)` が全ての編集ツールを既に覆っているため一度もマッチしていなかった
並行の `Write(.env)` / `Write(.env.*)` / `Write(secrets/**)` エントリは削除した
(`Write` という別ツールが存在するかのような誤解を招くだけで、実効性がなかった)。

`guard.mjs` 側では実バグも見つかった。gate ファイル判定 (`isGateFile`) は
`/^package\.json$/` のようなアンカー付き正規表現を、パスの先頭 `./` を落としただけの
文字列に当てていたが、Claude Code が Edit/Write で送る `file_path` は常に
**絶対パス**であり、`/Users/x/repo/package.json` のような文字列はどのパターンにも
一致しない。つまり **gate 除去検知は実際の Edit/Write 呼び出しに対して一度も
発火していなかった**。`scripts/lib/node-tools.mjs` の既存 export `repoRoot` を使い、
`path.resolve` + `path.relative` でリポジトリ相対パスに正規化してから照合するよう
修正し、絶対パスでの gate マーカー削除をブロックする回帰テストを追加した。

ルールエンジンを `scripts/lib/guard/` へ抽出し、git の staged content を検査する
pre-commit 層(`scripts/check-staged.mjs`)を新設する話は別途行う。§19 参照。

---

## 19. ルールエンジンを `scripts/lib/guard/` に抽出し、pre-commit 層を新設（2026-08-24 追記）

§18 の時点で `.claude/hooks/guard.mjs` は 775 行の単一ファイルで、Claude Code
セッションの中でしか効かなかった。人間が直接コミットした場合や別ツールが
コミットした場合には一切効かないため、誰がコミットしても効く層を別途設けることにした。

Enforcement を4層に整理した(詳細は `AGENTS.md` の「Enforcement layers」節):

1. `.claude/settings.json` の `permissions.deny` — §18 で追加済み。宣言的に書ける
   パス/コマンドの拒否。
2. `.claude/hooks/guard.mjs`(PreToolUse)— (1) が表現できない意味判断を担う。
3. `lefthook` pre-commit / pre-push — 誰が(人間・Codex・その他ツール)コミットしても
   効く唯一の層。新設の `scripts/check-staged.mjs` が staged diff から
   認証情報混入・gate マーカー削除・gate ファイルの staged deletion・
   `.env*`/`secrets/**` の staging を検査する。**lockfile の手編集はここでは検査しない**
   — 再生成された lockfile のコミットは正常な作業であり、diff だけでは
   「手編集」と「`pnpm install` の出力」を区別できないため。
4. `AGENTS.md` 自身 — 上記3層がなぜそうなっているかの説明。

規則の実装(パス/認証情報/gate マーカー判定、shell の字句解析)は `guard.mjs` から
`scripts/lib/guard/`(`paths.mjs` / `credentials.mjs` / `gates.mjs` / `shell.mjs` /
`commands.mjs`)に一本化した。移動した約683行は `export` を付けた以外バイト単位で
同一で、振る舞いの変更はない。`.claude/hooks/guard.mjs` と `scripts/check-staged.mjs`
の両方がそこから import することで、規則が二重管理にならない。将来 Codex 側の hook を
書くときも、この層をそのまま import する薄いアダプタを足すだけで済む設計にした。

抽出は §18 のバグとは別の自己参照バグを顕在化させた。旧 `GATE_FILES` は
`CONFIG_GATE_FILES`(マーカー走査 + 削除保護の対象になる設定ファイル)と
`ENFORCEMENT_FILES`(削除保護のみの対象 — エンジン自身の実装ファイル)に分割した。
`GATE_MARKERS` の正規表現ソース文字列自体が `gates.mjs` に載っているため、
このファイル自身を「マーカーが消えたか」で走査すると、抽出のようなリファクタが
軒並み「gate 削除」と誤検知される。実際に必要なマーカー走査対象は
`CONFIG_GATE_FILES` の設定ファイル群だけであり、エンジンの実装ファイルは
削除保護だけ効けばよい。

`lefthook.yml` の pre-commit には `check:staged`(`scripts/check-staged.mjs` を叩く)
に加えて `typecheck`(プロジェクト全体、実測 ~2秒)と `test:related`(`vitest related`
で staged ファイルのモジュールグラフから関係するテストだけを走らせる)も追加した。
この2つは enforcement 層そのものとは無関係な pre-commit の強化だが、過分割を避けて
同じコミットにまとめた。
