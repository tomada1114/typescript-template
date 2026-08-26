# Phase 5: 生成物の AI-native layer 整合

> **前提**: Phase 4 完了（`scripts/bootstrap.mjs` と `tests/bootstrap.test.ts` が動き、
> 3 profile の生成 E2E が green）。
> 開始前に [README.md](README.md) と [decisions.md](decisions.md) を読むこと。

## なぜこの Phase があるか

Phase 3 で `AGENTS.md` / `CLAUDE.md` / `.claude/**` を実装し、Phase 4 で bootstrap を
実装しますが、**Phase 4 の文書はこの2つを一度も接続していません**。
`docs/template-requirements/03-bootstrap-release-and-dod.md` §1 の bootstrap 責務にも
AI-native layer は現れません。

結果として、bootstrap を仕様どおりに実装しただけでは、生成されたリポジトリの
AGENTS.md と `.claude/rules/` が**テンプレート自身のことを説明したまま**残ります。

この Phase は、その接続だけを担当します。

### 厄介な点

これらの不整合は **placeholder 文字列を含みません**。したがって Phase 4 が実装する
「残存 placeholder 全件検査」でも「不要 profile file がゼロ」検査でも捕まりません。
生成物は `pnpm check` が green のまま、間違ったことを書いた指示書を持ちます。
**サイレントな失敗なので、専用の assert がないかぎり誰も気付きません。**

## 完了条件

> 3 profile それぞれの生成物について、`AGENTS.md` / `CLAUDE.md` / `.claude/**` が
> その生成物自身の構成だけを説明しており、存在しないファイル・ディレクトリを
> 参照していないことが、テストで固定されている。

---

## セッション開始プロンプト

```
このリポジトリの Phase 5（生成物の AI-native layer 整合）を実装してください。

まず次を全文読む:
1. docs/template-implementation/README.md
2. docs/template-implementation/decisions.md   ← 検証済みの版・設計判断。再調査・再設計しない
3. docs/template-implementation/phase-5-generated-repo-ai-layer.md（この文書）
4. docs/template-implementation/phase-3-ai-native-workflow.md（AI-native layer の設計意図）
5. docs/template-implementation/phase-4-bootstrap-and-release.md §4（bootstrap の責務と安全要件）
6. docs/template-requirements/02-quality-security-ai.md §7
7. 実装済みの scripts/bootstrap.mjs と tests/bootstrap.test.ts

bootstrap の設計（一時コピー上で変換 → 成功したら反映、tracked files だけ、
dry-run、再実行安全）は Phase 4 のものをそのまま使う。新しい変換機構を作らない。

禁止:
- guard を緩めて通す、security gate の削除
- test の skip/disable、coverage 80% 閾値の引き下げ、型エラーや lint の抑制
- 実 push / PR 作成 / publish
- AI-native layer の設計そのものの作り直し（Phase 3 の決定は再設計しない）

完了時に、この文書の「検証」節のコマンドを実行し、command / summary / exit code を示すこと。
```

---

## 実装するもの

### 1. bootstrap の変換対象に AI-native layer を含める

Phase 4 の bootstrap は tracked files を走査するので、`AGENTS.md` / `CLAUDE.md` /
`.claude/**` は**既に走査対象に入っています**。足りないのは、それらに対する
**profile 差分の適用**と**削除ディレクトリ参照の除去**です。

#### 1.1 削除される2ディレクトリへの参照

bootstrap は生成先から `docs/template-requirements/` と `docs/template-implementation/`
を削除します。現時点でこの2つを参照している箇所:

| ファイル                | 内容                                                           |
| ----------------------- | -------------------------------------------------------------- |
| `.claude/rules/docs.md` | "Generated and copied trees" 節の2項目（両ディレクトリの説明） |
| `AGENTS.md`             | 最小 Node 検証の節が `decisions.md` を参照                     |
| `AGENTS.md`             | Conventions 節が `docs/template-requirements/` を参照          |

実装時に**現物を grep して確認する**こと（この表は Phase 3 完了時点のもの）:

```bash
grep -rn 'docs/template-\(requirements\|implementation\)' AGENTS.md CLAUDE.md .claude/
```

#### 1.2 profile 依存の記述

`node-library` と `universal-library` では `src/cli.ts` / `src/bin.ts` /
`tests/cli.test.ts` が削除されます。現時点でこれらを説明している箇所:

| ファイル                   | 内容                                                     |
| -------------------------- | -------------------------------------------------------- |
| `AGENTS.md`                | Architecture のツリー図に `cli.ts` / `bin.ts` の行がある |
| `.claude/rules/source.md`  | CLI 分割（`CliIo`、`runCli`、bin shim）の説明が2項目     |
| `.claude/rules/testing.md` | `src/bin.ts` の coverage 0% を説明する項目               |

同じく実装時に grep で確認する。**接頭辞なしの裸のファイル名も拾うこと** ——
`AGENTS.md` の Architecture ツリーは `cli.ts` とだけ書いており、
`src/cli.ts` で検索すると取りこぼす:

```bash
grep -rniE 'cli\.ts|bin\.ts|runCli|CliIo|dist/bin\.js' AGENTS.md CLAUDE.md .claude/
```

### 2. 変換方式の選択（この Phase の主要な設計判断）

**先に方式を決めてから実装すること。** Phase 4 の README「Use this template」節を
どう扱うかと同じ問題なので、**そちらと同じ方式に揃える**のが望ましい。

| 方式                        | 内容                                                                                                                               | 評価                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **A. マーカーで括る**       | `<!-- template-only:start -->` … `<!-- template-only:end -->` / `<!-- profile:node-cli -->` で括り、bootstrap が該当ブロックを削除 | 決定論的。差分が読める。マーカー自体が「これは生成時に消える」という文書になる |
| B. 節見出しで判定           | 特定の `##` 節を丸ごと削除                                                                                                         | マーカー不要だが、見出しを変えると壊れる。暗黙の結合                           |
| C. profile ごとに別ファイル | `AGENTS.node-cli.md` などを用意して選択                                                                                            | 重複が3倍。同じ文を3箇所で保守することになる                                   |

**推奨は A。** 採用したら、マーカーの構文を1箇所（bootstrap のコメント）に定義し、
`.claude/rules/docs.md` にも「このマーカーは bootstrap が消す」と書く。

Markdown のマーカーは Prettier が整形しても壊れないこと（HTML コメントは保持される）を
実測で確認すること。

### 3. placeholder / 残存参照の検査を AI-native layer に広げる

Phase 4 の「残存 placeholder 全件検査」を、`AGENTS.md` / `CLAUDE.md` / `.claude/**`
にも必ず適用する（tracked files 全体を対象にしていれば自動的に満たされる。
明示的に**除外していないこと**を確認する）。

加えて、この Phase で新設する検査:

- 生成物の `AGENTS.md` / `CLAUDE.md` / `.claude/**` に、生成先に**存在しない**
  ファイル・ディレクトリへの参照が残っていないこと
- library profile の生成物に `cli.ts` / `bin.ts` の語が残っていないこと

### 4. `tests/bootstrap.test.ts` への追加ケース

Phase 4 のテストに、profile ごとに次を追加する:

- `AGENTS.md` / `CLAUDE.md` / `.claude/**` に `docs/template-requirements` と
  `docs/template-implementation` の文字列が残らない
- library profile で `src/cli.ts` / `src/bin.ts` / `tests/cli.test.ts` への参照が残らない
- `node-cli` profile では逆に**残っている**こと（消しすぎの検出）
- Preserve `.agents/hooks/*.mjs`, `.codex/hooks.json`, and `.claude/skills/**` unchanged across profiles
- 生成物で `tests/hooks.test.ts` が green（生成 E2E の `pnpm check` に含まれる）

### 5. `.claude/skills/merge-dependabot` の扱い

profile によらず**そのまま残す**。placeholder は含まないが、次を確認する:

- `SKILL.md` が参照する `.github/PULL_REQUEST_TEMPLATE.md` と
  `.github/workflows/check-pr-title.yml` が生成物にも存在すること
- `survey-prs.mjs` の相対 import（`../../../../scripts/lib/`）が生成物でも解決すること
- 生成物で `pnpm run typecheck` と `pnpm run lint` がこのファイルを見ていること
  （`tsconfig.json` の `include` と `eslint.config.mjs` の glob に
  `.claude/skills` が入っている前提。Phase 3 で追加済み）

---

## 検証

```bash
# 既存 gate（両 Node）
pn24 run check
pn22 run check

# bootstrap の全ケース（Phase 5 で追加した assert を含む）
pn24 run test

# 3 profile の生成 E2E（Phase 4 で実装した検証スクリプト経由）
# 生成物ごとに、この文書 §3 の残存参照検査が exit 0 であること

# 生成物側で実際に grep して目視確認する（テストの裏取り）
#   library profile の生成物で 0 件になること
grep -rn 'cli\.ts\|bin\.ts\|template-requirements\|template-implementation' \
  "$DEST/AGENTS.md" "$DEST/CLAUDE.md" "$DEST/.claude/"

# 最終状態
git status --short
```

期待: すべて exit 0。生成物に不整合な参照が0件。
このリポジトリでは**コミットしない**。作業ツリーに残し、人間がレビューしてコミットする。

---

## DoD 対応

| DoD | 項目                                              | 対応                                                 |
| --- | ------------------------------------------------- | ---------------------------------------------------- |
| A   | 生成後に他 profile の不要ファイル・依存が残らない | **指示文書からの記述削除**まで含めて満たす           |
| A   | 新規生成物に placeholder が残らない               | 検査対象に `AGENTS.md` / `.claude/**` を含める       |
| I   | `AGENTS.md` が正本                                | 生成物でも正本であり続ける（内容が生成物と一致する） |
| I   | path-scoped rules                                 | 生成物の rules が生成物自身の構成を説明する          |
| J   | docs/example が public API と同期                 | 指示文書も同期対象に含める                           |

---

## やらないこと

- AI-native layer の設計変更（hooks の追加・削除、guard の規則変更）。
  Phase 3 の決定は再設計しない
- bootstrap の変換機構そのものの作り直し。Phase 4 の実装を使う
- `.claude/skills/` の追加移植。`merge-dependabot` 1本という判断は確定済み
- `zukai` 固有の実装

---

## 積み残しとして記録すること

この Phase で解消しない既知のリスクは、仕様 README §5 の「延期する項目」として
理由・受け入れるリスクとともに記録する。Phase 3 時点で判明しているもの:

| 項目                                           | 内容                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format.mjs` の autofix が編集の意味を変えうる | ESLint autofix は隣接する文字列リテラルの畳み込みなど、空白以外も書き換える。仕様 02 §7.2 が要求する動作そのものなので実装は変えない。`CLAUDE.md` に注意書き済み |
| guard の静的解析は best-effort                 | `eval`、変数展開、here-document 経由のコマンドは捕捉しない。guard.mjs 冒頭のコメントに明記済み。CI と branch protection が本来のゲートである                     |
