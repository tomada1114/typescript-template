# Phase 1: publish artifact quality

> **前提**: Phase 0 完了（`pnpm check:quick` が Node 22.14.0 / 24.18.1 の両方で exit 0）。
> 開始前に [README.md](README.md) と [decisions.md](decisions.md) を読むこと。

## 完了条件（仕様 03 §5）

> repository source を参照せず、tarball だけから runtime と型 consumer が成功する。

このフェーズで `pnpm check`（フル）が初めて green になります。

---

## セッション開始プロンプト

```
このリポジトリの Phase 1（publish artifact quality）を実装してください。

まず次を全文読む:
1. docs/template-implementation/README.md
2. docs/template-implementation/decisions.md   ← 検証済みの版・設計判断。再調査・再設計しない
3. docs/template-implementation/phase-1-publish-artifact-quality.md（この文書）
4. docs/template-requirements/01-repository-design.md §6, §7
5. docs/template-requirements/02-quality-security-ai.md §4（tarball smoke test）
6. docs/template-requirements/03-bootstrap-release-and-dod.md §6 の DoD B, C, E

要件の正本は docs/template-requirements/ で、実装の決定事項は decisions.md。
矛盾したら要件の正本を優先し、差異を報告する。

進め方:
- 新しい振る舞いはテストを先に書き、red を実行して要点を示してから実装する
- 小さな論理単位で進め、各反復後に completed / remaining を報告する
- 仕様と decisions.md に明示された設計を再設計しない

禁止:
- test の skip/disable/削除、assertion の弱体化、coverage 80% 閾値の引き下げ
- 型エラーや lint の抑制、security gate の削除、pnpm-lock.yaml の手編集
- 実 npm publish、push、PR 作成
- zukai 固有の実装（Playwright / Iconify / MCP / 画像 golden test）

完了時に、この文書の「検証」節のコマンドを Node 22.14.0 と 24.18.1 の両方で実行し、
command / summary / exit code を示すこと。
```

---

## 実装するもの

### 1. API Extractor

| ファイル                                               | 内容                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api-extractor.json`                                   | `mainEntryPointFilePath: <projectFolder>/dist/index.d.ts`、`apiReport.enabled: true`、`reportFolder: <projectFolder>/etc/`、`reportTempFolder: <projectFolder>/temp/`、`docModel` / `dtsRollup` / `tsdocMetadata` は無効、3種の message reporting を `error` |
| `etc/<unscoped-name>.api.md`                           | `pnpm api:update` で生成してコミット                                                                                                                                                                                                                         |
| `src/errors.ts`, `src/identifier.ts`, `src/timeout.ts` | 公開宣言に `@public` を付ける                                                                                                                                                                                                                                |

**decisions.md §12 の前提を必ず読むこと**（`etc/` の事前作成、release tag 必須、
`reportFileName` を指定しない、`temp/` を gitignore、TS 版警告は無視してよい）。

`pnpm api:check` は committed report との差分で失敗すること。差分があるときは
`pnpm api:update` を人間が意図的に走らせる運用。

### 2. TypeDoc

`typedoc.json`: `entryPoints: ["src/index.ts"]`、`tsconfig: "tsconfig.build.json"`、
`out: "docs/api"`、`treatWarningsAsErrors: true`、`validation` は
`notExported` / `invalidLink` / `rewrittenLink` / `notDocumented` / `unusedMergeModuleWith` を有効。
`docs/api/` は `.gitignore` 済み（`docs/*.md` は手書きで tracked）。

### 3. tarball 検査 `scripts/check-package.mjs`

**pure function を export してテスト可能にする**（`tests/package.test.ts` から import）。

- `readTarEntries(buffer)`: `zlib.gunzipSync` + ustar ヘッダを自前パース。
  外部 `tar` コマンドにも依存パッケージにも頼らない（全 OS で同一挙動、
  dependency review の面積も増えない）。`path` / `size` / `mode` を返し、
  npm が付ける先頭の `package/` は除去する。GNU long name (`L`) と pax (`x`/`g`) を考慮。
- `ALLOWED_PATHS`: **allowlist**。`package.json` / `README*` / `LICEN[SC]E*` /
  `dist/**` の `.js` `.d.ts` `.js.map` `.d.ts.map` のみ。
  npm が `files` に関係なく必ず入れるものがあるので、それも明示的に許可する。
- `FORBIDDEN_PATHS`: `.env*` / `secrets/` / `.npmrc` / `*.pem|key|p12|pfx` / `id_rsa` /
  `src/` / `tests?/` / `*.test.*` / `fixtures?/` / `coverage/` / `node_modules/` /
  `*.tsbuildinfo` / `.git*` / `.claude/` / `.github/` / `scripts|etc|docs/`。
  allowlist で既に落ちるものでも**理由付きで別途検出**する（エラーが「許可されていない」ではなく
  実際の危険を名指しする）。
- `requiredEntryPaths(manifest)`: `exports` / `types` / `bin` / `main` / `module` の
  文字列 leaf を再帰収集する。**ハードコードしない**。これが仕様 01 §1.3 の
  「build entry と package exports の二重管理をテストで検出」に当たる。
- `PACKAGE_LIMITS`: `maxUnpackedBytes` / `maxFileCount` / `maxSingleFileBytes` を
  **tracked ファイル内のリテラル**で持つ（引き上げが review diff に出る、仕様 02 §4）。
- エラーは仕様 02 §7.3 に従う: 何が失敗したか / 対象 path / 期待値と実測値 /
  次に実行すべき安全なコマンド / error code、秘密や絶対 home path を含めない。
  超過時は上位ファイルも示す。

### 4. tarball smoke test `scripts/smoke-package.mjs`

仕様 02 §4 の 1〜13 を実装。**repository の `src/` / `dist/` を import しない。**

1. clean build（`pnpm run build` を script チェーンの先頭に置く）
2. `pnpm pack` で `.tgz` を1個だけ生成（**pack は package.json script 側で行う**、decisions.md §5）
   3〜5. `check-package.mjs` による allowlist / 禁止パス / size 検査
3. `os.tmpdir()` に throwaway consumer を作り `npm install <tgz>`
   （`--no-audit --no-fund --no-package-lock --ignore-scripts`）
4. package root と `exports` の全公開 subpath を dynamic import。
   default export が無いこと、named export があることを assert。
   root API を実際に呼ぶ（`normalizeIdentifier` / `withTimeout`）
5. CLI の `--version` 出力が `package.json` の version と一致
6. 一時 TypeScript consumer を **NodeNext** で compile。
   `tsc --listFiles` の出力に `<repo>/src` `<repo>/dist` 配下が現れないことを assert
   （= 公開 declaration が自己完結している証明）
7. universal profile のときだけ `moduleResolution: "Bundler"` の consumer も compile
   （profile 判定は `tsconfig.build.json` の `types: []`、decisions.md §10）
8. node-cli のとき: shebang / tarball 内の実行 bit / `node_modules/.bin/<name>` の生成 /
   `--help` / `--version` / 不正引数 exit 2 + stderr 非空 + stdout 空 /
   rejected input exit 1
9. 非公開 deep import（`<pkg>/dist/internal/assert.js`）が
   `ERR_PACKAGE_PATH_NOT_EXPORTED` で失敗すること
10. 成功・失敗どちらでも temp ディレクトリと pack ディレクトリを削除（`finally`）

加えて仕様 02 §4 の完了条件から:

- `dist/**/*.map` の `sources` に**絶対パスが無い**こと（build machine の path を漏らさない）

補助ファイル:

- `scripts/lib/is-main.mjs` — CLI / module 兼用の自動実行ガード（decisions.md §8）
- `scripts/lib/tarball.mjs` — `findSingleTarball(dir)`

### 5. attw ラッパ `scripts/check-attw.mjs`

**decisions.md §4 を必ず読む。** `attw --pack` は使えない。
`pnpm pack --pack-destination .attw` の成果物を受け取り、`attw <tgz> --profile esm-only` を実行する。

### 6. `package.json` の script 差し替え

```jsonc
"clean":          "node scripts/clean.mjs dist coverage docs/api temp .package .smoke .attw .rehearsal .eslintcache",
"package:check":  "pnpm run build && ... pnpm pack --pack-destination .package && pnpm run package:verify -- --pack-dir .package",
"package:verify": "node scripts/verify-package.mjs",
"package:smoke":  "pnpm run build && ... pnpm pack --pack-destination .smoke && node scripts/smoke-package.mjs --pack-dir .smoke",
```

`verify-package.mjs` が、すでに作成された 1 つの tarball に publint / attw /
consumer smoke を順に適用する。release workflow は `--tarball <file>` を使い、
検査・publish・GitHub Release 添付の対象を固定する。

`.gitignore` に `.package/`、`.smoke/`、`.attw/`、`temp/` を追加。

### 7. `tests/package.test.ts`

- `readTarEntries`: 合成した tar buffer と実 tarball の両方
- `inspectPackageEntries`: 合成 entry 配列で allowlist / 禁止パス / 各 limit の
  境界（ちょうど上限 / 上限+1）を検査
- `requiredEntryPaths`: ネストした `exports`、`bin` の文字列形とオブジェクト形、`./` 接頭の除去
- 実 tarball に対して problems が 0 件であること

---

## 検証

```bash
# 単体
pn24 run api:check
pn24 run package:check
pn24 run package:smoke
pn24 run docs:build

# フル（Phase 1 で初めて green になる）
pn24 run check
pn22 run check

# 作業ツリーが `pnpm check` で変化しないこと（仕様 01 §7 完了条件3）
pn24 run check && git status --short
```

期待:

- 全て exit 0
- `git status --short` に生成物が現れない（`.smoke` / `.attw` / `temp` / `docs/api` は
  gitignore 済み、かつスクリプトが削除している）
- coverage は 80% 閾値を維持（`src/bin.ts` の 0% を exclude しない、decisions.md §11）

---

## DoD 対応

| DoD | 項目                                                | 対応                                          |
| --- | --------------------------------------------------- | --------------------------------------------- |
| B   | API report が committed で差分が review できる      | `etc/<name>.api.md` + `api:check`             |
| B   | root/public subpath 以外の deep import が拒否される | smoke step 12                                 |
| C   | `pnpm check` が非破壊                               | `check` 後の `git status --short`             |
| E   | clean build で JS / `.d.ts` / map が生成される      | `pnpm build` + tarball の required entry 検査 |
| E   | publint と attw が error ゼロ                       | `package:lint`                                |
| E   | tarball の path / size / file count に gate がある  | `check-package.mjs`                           |
| E   | secret / source / test / cache が tarball にない    | `FORBIDDEN_PATHS`                             |
| E   | tarball install 後の ESM import が成功              | smoke step 7                                  |
| E   | tarball install 後の consumer `tsc` が成功          | smoke step 9                                  |
| E   | CLI profile の help / version / error / exit code   | smoke step 11                                 |
| E   | universal profile の bundler consumer が成功        | smoke step 10（Phase 4 の生成 E2E で実測）    |
| E   | package smoke が repository source を import しない | smoke step 9 の `--listFiles` assert          |

---

## やらないこと

- CI workflow（Phase 2）
- AGENTS.md / hooks（Phase 3）
- bootstrap / community 文書 / release / release workflow（Phase 4）
- bundler（`tsdown` 等）の導入。仕様 01 §5 の導入条件を満たしていない
