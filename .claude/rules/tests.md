---
paths:
  - "tests/**"
---

# Tests

## Where a test goes

- Every test is `tests/<module>.test.ts`, never next to the source. `tests/fixtures/` is
  data under test, ignored by every tool on purpose, never imported as a module.
- `vitest.config.ts` has two projects. A test starts in `unit` (imports only `src/**`,
  no filesystem, subprocess or git, short timeout). Add its path to the explicit
  `automationTests` list once it does I/O. Forgetting fails loudly (timeout); listing a
  pure test there is the quiet mistake.
- Three coverage floors answer three questions: `src/**` (the contract), `scripts/**`
  (raised only to a measured value), `scripts/lib/guard/**` (the secret guard, held
  higher). Read the numbers in `vitest.config.ts`. A new file counts at 0% from the
  moment it exists, so its test lands in the same pull request.
- Coverage stops at the process boundary: code that only runs in a spawned child reports
  0%. Keep the child thin and the logic callable in-process.

## What a test asserts

- Name the behavior (`rejects a fractional timeout`), one behavior per `it`, variations
  through `it.each` with labelled titles. Test through `src/index.ts`, never
  `src/internal/`.
- An expected value comes from outside the code under test — a literal, a worked example
  — never recomputed the way the implementation computes it.
- Assert an error's class and `code`, never its message.
- Sweep `0`, `1`, negative, fractional, `Number.MAX_SAFE_INTEGER`, absent vs explicit
  `undefined`, unicode and emoji, duplicates, cancellation and cleanup.
- Mock only at boundaries (network, filesystem, clock, child process, randomness);
  prefer an in-memory fake. Fake timers with `vi.advanceTimersByTimeAsync`, never a real
  sleep. Filesystem tests use a fresh `mkdtempSync` directory removed in `afterEach`.
- `vitest.config.ts` already restores mocks and stubs; clean up explicitly only what it
  does not know about (timers, listeners, temp directories, child processes).

## Type tests

`tests/types.test.ts` holds every `expectTypeOf` assertion: inferred return types
(literals preserved), generics passed through unwidened, accepted and rejected inputs,
union narrowing. Three ways such a test passes while proving nothing:

1. A `@ts-expect-error` call inlined in `it()` still runs. Put the invalid call inside a
   function that is never invoked.
2. `const e: A | B = new B()` narrows to `B`. Receive the value as a function parameter
   typed as the union.
3. `@ts-expect-error` is satisfied by any error, including a typo. Pair it with an
   `expectTypeOf` on the valid call.

These check the source's view only; `pnpm package:smoke` checks what a consumer sees.
