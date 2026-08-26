# Phase 3: AI-native workflow

> **前提**: Phase 2 完了（CI workflow が揃い、`actionlint` と構造テストが green）。
> 開始前に [README.md](README.md) と [decisions.md](decisions.md) を読むこと。

## 完了条件（仕様 03 §5）

> 通常変更は高速に進められ、protected file と publish/Git bypass は決定論的に拒否される。

---

## セッション開始プロンプト

```
このリポジトリの Phase 3（AI-native workflow）を実装してください。

まず次を全文読む:
1. docs/template-implementation/README.md
2. docs/template-implementation/decisions.md   ← 検証済みの版・設計判断。再調査・再設計しない
3. docs/template-implementation/phase-3-ai-native-workflow.md（この文書）
4. docs/template-requirements/02-quality-security-ai.md §7, §8
5. docs/template-requirements/03-bootstrap-release-and-dod.md §6 の DoD I
6. 参考（移植元）:
   /Users/masuyama/ghq/github.com/tomada1114/uv-template/AGENTS.md
   /Users/masuyama/ghq/github.com/tomada1114/uv-template/CLAUDE.md
   /Users/masuyama/ghq/github.com/tomada1114/uv-template/.claude/ 配下すべて

uv-template の hooks は Python（uv run --script）なので、TypeScript/npm 向けに
.mjs へ翻訳する。ロジックの構造（segment 分割、短縮オプションのクラスタ解析、
stop_hook_active による再帰防止）は積極的に流用する。Python 固有の語を残さない。

重要な前提:
- .mjs では Node グローバルを明示 import する（decisions.md §7）
- .mjs は tsconfig の checkJs で型検査される。JSDoc で型を付ける（decisions.md §6）
- lefthook.yml は現在 lefthook postinstall が作った雛形のまま。置き換える（decisions.md §13）

禁止:
- guard を緩めて通す、security gate の削除
- test の skip/disable、coverage 80% 閾値の引き下げ、型エラーや lint の抑制
- 実 push / PR 作成 / publish

完了時に、この文書の「検証」節のコマンドを実行し、command / summary / exit code を示すこと。
```

---

## 実装するもの

### 1. 指示の正本と tool-specific layer（仕様 02 §7.1）

| ファイル    | 役割                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------- |
| `AGENTS.md` | **正本**。全エージェント共通の architecture / commands / quality / security / public API 規約 |
| `CLAUDE.md` | `@AGENTS.md` を import し、**Claude Code 固有の差分だけ**を書く                               |

`AGENTS.md` に lint rule を全文転記しない。**機械で強制できるものは config を正本**にし、
文書は設計理由と判断基準を説明する（仕様 02 §7.1 末尾）。

`AGENTS.md` に必ず含めるもの:

- Quick reference（`pnpm check:quick` / `pnpm check` / `pnpm fix` / `pnpm api:update` など）
- アーキテクチャ（`src/index.ts` が公開契約の唯一の起点、`src/internal/` は非公開）
- 公開 API を変える PR は実装・振る舞いテスト・型テスト・API report・
  README/API docs・Changeset を**同じ PR で**更新する（仕様 01 §8 末尾）
- 最小 Node での検証時は `pnpm --config.runtime-on-fail=ignore …`（decisions.md §3）
- `.mjs` の規約（Node グローバルの明示 import、JSDoc 型、`is-main` ガード）
- property-based test（`fast-check`）の**適用条件**。placeholder には依存を入れない
  （仕様 02 §3.3 末尾）
- commit / push / PR / publish は常に人間の許可が必要

### 2. path-scoped rules `.claude/rules/`

| ファイル          | paths                                                          | 内容                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.md`       | `src/**/*.ts`, `scripts/**/*.mjs`                              | 設計・エラー処理・型システム・命名。**ESLint が機械的に強制している規則は書かない**                                                                                     |
| `testing.md`      | `tests/**/*.ts`                                                | 構造、何をテストするか、境界値、エラー検査、fake timers、coverage 哲学、アンチパターン                                                                                  |
| `docs.md`         | `docs/**/*.md`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` | 自明なことを書かない、コード例は現行 API で動くこと                                                                                                                     |
| `package-json.md` | `package.json`, `pnpm-workspace.yaml`                          | 依存追加時の審査項目（仕様 01 §6, 02 §6.2）、`minimumReleaseAge` の意味と 7日、`exports`/`files` は allowlist、coverage 閾値を下げない、lockfile は同じ commit に含める |

`testing.md` は uv-template の `.claude/rules/testing.md` が非常に良く出来ているので、
Vitest / TypeScript 向けに翻訳して流用する（`pytest.raises` → `expect().toThrow`、
`@pytest.mark.parametrize` → `it.each`、`monkeypatch` → `vi.stubEnv`、
`freezegun` → `vi.useFakeTimers`、`hypothesis` → `fast-check`）。

### 3. hooks `.agents/hooks/*.mjs`（仕様 02 §7.2）

| hook             | イベント                                            | 動作                                                                                                              |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `format.mjs`     | PostToolUse (`Edit\|Write\|apply_patch`)            | Run ESLint autofix and Prettier on every edited file; exit 2 reports failures to the agent                        |
| `stop-check.mjs` | Stop                                                | Run the `pnpm check:quick` equivalent for TS or package-config changes; prevent recursion with `stop_hook_active` |
| `guard.mjs`      | PreToolUse (`Edit\|Write\|Read\|Bash\|apply_patch`) | Reject the operations below with **exit 2**                                                                       |

`guard.mjs` の拒否対象（仕様 02 §7.2）:

- `pnpm-lock.yaml` の直接編集
- `.env*`（`.example` / `.sample` / `.template` は除く）と `secrets/**` の read/write
- `npmrc` の auth token、private key、credential の書き込み
- `git commit --no-verify`（`-n` のクラスタ形も含む）
- `git push --force`（`--force-with-lease` は人間承認の上で許容）
- `npm publish` / `pnpm publish` / release workflow の dispatch
- security gate の削除、coverage threshold の引き下げ

実装上の注意（uv-template の `guard.py` から流用する構造）:

- Bash コマンドは shell 制御演算子（`&&`, `||`, `;`, `|`, `&`, 改行）で **segment 分割**し、
  segment ごとに argv を独立に判定する。1つのコマンドのフラグが他のコマンドの判定に
  影響しないようにする
- `git -C dir push …` のように値を取る git global option を読み飛ばす
- 短縮オプションのクラスタ（`-am"msg"`）は、値を取るオプション以降を値として扱い走査を止める
- リダイレクト（`>`, `>>`）、`tee` / `truncate` / `sed -i` / `dd of=` / `cp` / `mv` の
  書き込み先を best-effort で抽出する
- 静的解析は best-effort。「エージェントが素直に書く綴り」を捕まえるのが目的で、
  あらゆる shell 構文を網羅するものではない —— この限界をコメントに明記する
- **ここは後発の確定記録である decisions.md §18（2026-08-24 追記）を優先する。**
- Claude Code permission の `deny` は advisory ではなく、**bypassPermissions モードを
  含む全モードで hard enforce される**。ただし Bash の引数パターンは fragile なので、`&&`
  チェーンや wrapper などの静的解析で扱えないケースを補完するため **hook も必要**である

### 4. `.claude/settings.json`

- `permissions.allow`: **ローカルの build / lint / test だけ**
  （`pnpm check:quick`, `pnpm check`, `pnpm test`, `pnpm lint`, `pnpm typecheck`,
  `pnpm build`, `pnpm fix`, `pnpm api:check`, `pnpm package:smoke` など）
- `permissions.deny`: `/.env` / `/.env.*` / `/secrets/**` の Read/Edit（`Write` の path rule は
  受理されても参照されず、起動時 warning になるため追加しない）。**先頭の `/` は必須**で、
  これが settings ファイルの位置を基準に固定する。これを省いた bare path は
  cwd 相対に解決されるため、サブディレクトリで起動したセッションではリポジトリ
  ルートの `.env` を覆わない（#15）
- `hooks`: register the three hooks above, resolve `.agents/hooks` from the Git top level, and set timeouts
  （format 60s / stop-check 180s / guard 30s 目安）
- 個人設定（model、output style、追加 permission）は `.claude/settings.local.json` に置き、
  **ここには書かない**。`.gitignore` に登録済み

`$schema` に `https://json.schemastore.org/claude-code-settings.json` を指定する。

Codex CLI receives the same event, matcher, and command projection in
`.codex/hooks.json`. Because `apply_patch` can name several files inside
`tool_input.command`, the shared payload adapter extracts every path. Review
the command definitions with `/hooks` after project trust and after changes.

### 5. Lefthook `lefthook.yml`

現在は lefthook の postinstall が生成したコメントだけの雛形です（decisions.md §13）。置き換える。

- `pre-commit`: staged file に限定した高速チェック
  （変更された `*.ts` / `*.mjs` に ESLint、対象ファイルに Prettier `--check`）
- `pre-push`: `pnpm check:quick` 相当
- **同じ変更に対して local hook / `pnpm check:quick` / CI の結果が矛盾しないこと**
  （仕様 02 §8 完了条件3）。hook が独自の規則を持たず、必ず `package.json` scripts を呼ぶ

`pnpm hooks:install`（= `lefthook install`）は Phase 0 で script 定義済み。
CONTRIBUTING への記載は Phase 4。

### 6. `tests/hooks.test.ts` —— fixture test（DoD I 必須）

**正常系と拒否系の両方**を fixture で検査する（仕様 02 §8 完了条件2）。
hook は stdin に JSON payload を受け、exit code で結果を返すので、
Spawn `node .agents/hooks/guard.mjs` and feed it both Claude and Codex payloads.

許可されるべき例（exit 0）:

- 通常のソース編集（`src/identifier.ts` への Write）
- `.env.example` への Write
- `git commit -m "feat: add x"`
- `git push --force-with-lease origin feature`
- `pnpm test` / `pnpm check`

拒否されるべき例（exit 2 + stderr に理由）:

- `pnpm-lock.yaml` への Edit / `echo x > pnpm-lock.yaml`
- `.env` の Write / `cat .env` 系の読み出し
- `secrets/token.txt` への Write
- `git commit --no-verify -m "x"` と `git commit -nm "x"`
- `git push --force origin main`
- `npm publish` / `pnpm publish`
- 複合コマンド（`pnpm test && git push --force origin main`）で
  **後段だけが危険**なケースが拒否されること
- 逆に `git push --force-with-lease && echo ok` が許可されること

`format.mjs` / `stop-check.mjs` も、payload の `file_path` が対象外拡張子のとき
no-op（exit 0）になることをテストする。

---

## 検証

```bash
# 既存 gate
pn24 run check
pn22 run check

# hook fixture test
pn24 run test

# 実際に guard が効くことの手動確認（拒否されるのが正しい）
echo '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"pnpm-lock.yaml"}}' \
  | mise exec node@24.18.1 -- node .agents/hooks/guard.mjs ; echo "exit=$?"   # → 2

echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m x"}}' \
  | mise exec node@24.18.1 -- node .agents/hooks/guard.mjs ; echo "exit=$?"   # → 2

echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"pnpm test"}}' \
  | mise exec node@24.18.1 -- node .agents/hooks/guard.mjs ; echo "exit=$?"   # → 0

# guard を bypass せずに通常開発が完結すること（仕様 02 §8 完了条件4）
git status --short
```

期待: 全 gate exit 0、guard の拒否ケースは exit 2 で stderr に理由が出る。

---

## DoD 対応

| DoD | 項目                                              | 対応                                          |
| --- | ------------------------------------------------- | --------------------------------------------- |
| I   | `AGENTS.md` が正本                                | `AGENTS.md`                                   |
| I   | tool-specific file は差分だけ                     | `CLAUDE.md` が `@AGENTS.md` + Claude 固有のみ |
| I   | path-scoped rules                                 | `.claude/rules/*.md` の frontmatter `paths`   |
| I   | changed-file format hook                          | `.agents/hooks/format.mjs`                    |
| I   | quick stop gate                                   | `.agents/hooks/stop-check.mjs`                |
| I   | lockfile/secret/Git bypass/publish guard          | `.agents/hooks/guard.mjs`                     |
| I   | hook の fixture test                              | `tests/hooks.test.ts`                         |
| I   | commit/push/PR/publish は permission allowlist 外 | `.claude/settings.json`                       |

仕様 02 §8 の移植対応表（`uv-template` → TypeScript）についても、**各行に実ファイルまたは
明示的な「不採用理由」があること**を確認し、結果を報告する。`justfile` は仕様 T18 により
不採用（理由: Node 利用者に追加インストールを要求しない）。

---

## やらないこと

- bootstrap / community 文書 / Changesets / release（Phase 4）
- `.claude/skills/`。uv-template は `create-pr` / `smart-commit` / `merge-dependabot` を
  持つが、仕様のファイル構成（01 §2）には含まれていない。**入れない**か、
  入れるなら理由を報告して判断を仰ぐ
