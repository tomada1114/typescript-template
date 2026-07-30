---
paths:
  - "tests/**/*.ts"
---

## Structure and Organization

- Test files live in `tests/` and are named `tests/<module>.test.ts`; there
  is no co-location with `src/`.
- `describe`/`it` names describe behavior and scenario, not implementation
  (`it("rejects a fractional timeout", ...)`, not `it("test 3", ...)`).
- Follow Arrange-Act-Assert; group related cases under a nested `describe`.
- One behavior per `it`; multiple `expect` calls are fine when they all
  verify that same behavior.

## What to Test

- Test public behavior through `src/index.ts`'s exports, never through
  `src/internal/**` directly.
- Cover the happy path and the error path for every public function.
- If a function can throw or reject, assert the specific error class and its
  stable `code` (`.claude/rules/source.md`), not the free-text message.

## Edge Cases (always consider these)

- Boundary values: `0`, `1`, negative, fractional where an integer is
  required, `Number.MAX_SAFE_INTEGER`.
- Absent optional property vs. explicit `undefined` — `exactOptionalPropertyTypes`
  makes the two distinct at the type level, so exercise both when a public
  option is optional.
- Long strings, unicode/emoji, mixed encodings for anything text-shaped.
- Single-element and duplicate-element collections.
- Async: cancellation, timeout, and cleanup — see "Async and Timers" below.

## Error and Exception Testing

- Sync throw: `expect(() => fn()).toThrow(SpecificErrorClass)`.
- Async rejection: `await expect(promise).rejects.toThrow(SpecificErrorClass)`,
  or `await expect(promise).rejects.toThrow(/expected substring/)` when only
  the message shape matters.
- Prefer asserting on the error class and its `code`
  (`expect((error as InvalidInputError).code).toBe("ERR_INVALID_INPUT")`)
  over matching the message string, which is not part of the contract.
- Test that an error propagates through the full call chain (CLI parsing
  down to the library call), not only the library function in isolation.
- Test that cleanup runs on the failure path too, not only on success (timers
  cleared, listeners removed — see "Async and Timers").

## Type Tests

- Model: `tests/types.test.ts`. Use `expectTypeOf` for compile-time
  assertions on the public surface: inferred return types and generics,
  accepted inputs, rejected inputs, and discriminated-union narrowing.
- A `@ts-expect-error` call written directly inside `it()` still _runs_ at
  test time and produces an unhandled rejection. Wrap the invalid calls in a
  function that is declared but never invoked, and assert on the function
  itself, not on calling it:

  ```ts
  it("rejects input that is not a string", () => {
    const rejected = (): void => {
      // @ts-expect-error a number is not a valid identifier source
      normalizeIdentifier(42);
    };
    expect(rejected).toBeTypeOf("function");
  });
  ```

- `const error: A | B = new B()` narrows on the initializer, not the declared
  union type, so the `else` branch collapses to `never`. A discriminated-union
  type test must receive the value as a function parameter instead:

  ```ts
  const classify = (error: InvalidInputError | TimeoutError): void => {
    if (error.code === "ERR_TIMEOUT") {
      expectTypeOf(error).toEqualTypeOf<TimeoutError>();
    } else {
      expectTypeOf(error).toEqualTypeOf<InvalidInputError>();
    }
  };
  ```

- `tests/types.test.ts` checks the source's own type contract. The
  _published_ `.d.ts` is checked separately, from a consumer's point of view,
  by the tarball smoke test (`pnpm package:smoke`), which installs the packed
  tarball into throwaway consumers and runs `tsc` there. Neither substitutes
  for the other.

## Parametrize and Data-Driven Tests

- Use `it.each([...])` for input/output variations instead of copy-pasting
  test bodies (translates `@pytest.mark.parametrize`).
- Give each case a descriptive label through the `%s`/`%p` printf-style
  placeholders in the test title, not a bare index.

## Fixtures and Setup

- Prefer factory functions (`function makeX(overrides = {}) { ... }`) over
  shared static fixtures.
- Filesystem tests use a fresh temp directory,
  `mkdtempSync(path.join(tmpdir(), "prefix-"))`, and remove it in
  `afterEach`/`afterAll` with `rmSync(dir, { recursive: true, force: true })`
  (translates `tmp_path`). Never write to a real project directory.
- Environment variable tests use `vi.stubEnv("NAME", "value")` and restore
  with `vi.unstubAllEnvs()` in `afterEach` (translates `monkeypatch`),
  instead of mutating `process.env` directly.
- Anything that opens a resource (timer, listener, temp dir, child process)
  is cleaned up in `afterEach`/`afterAll`, even when the test itself failed.

## Mocking Strategy

- Mock only at boundaries: network, filesystem, clock, child process, random.
  Never mock the module under test.
- Prefer a real, in-memory implementation (a fake) over a mock for anything
  more than a one-shot boundary call (translates `unittest.mock`'s general
  guidance to `vi.fn()`/`vi.spyOn()`).
- Assert on behavior and captured arguments, not call counts — unless the
  count itself is the contract being tested (for example, "the deadline
  timer is cleared exactly once").

## Async and Timers

- No real `setTimeout` or sleep in tests. Use `vi.useFakeTimers()` and
  `await vi.advanceTimersByTimeAsync(ms)` (translates `freezegun`), and
  restore with `vi.useRealTimers()` in `afterEach`.
- An abortable API is tested for the cancellation path itself, and for the
  listener/timer it removes — on both the success path and the failure path.
  `tests/timeout.test.ts` is the model: `vi.spyOn(globalThis, "clearTimeout")`
  plus `vi.getTimerCount()` after a successful resolve, and
  `vi.spyOn(signal, "removeEventListener")` checked on both outcomes.
- Assert the caller-visible effect of an abort (the promise rejects with the
  forwarded reason), not just that some internal method was invoked.

## Property-Based Testing

- Reach for `fast-check` (translates `hypothesis`) when a function has a
  well-defined invariant over a large input space — parsers, normalizers,
  codecs, path/identifier transforms — not as a default for every function.
- `fast-check` is not currently a dependency, and the placeholder API has no
  case that needs it. Adding it is a real dependency decision: follow the
  review checklist in `.claude/rules/package-json.md` before introducing it.

## Test Independence and Reliability

- Tests are independent: no shared mutable module state, no ordering
  dependency; each test passes when run alone.
- No `it.skip`/`it.todo` left on `main`; delete the test or fix it.
- No dependence on timezone, locale, CPU count, or real wall-clock time.
- A flaky test is fixed immediately, not retried or ignored.

## Coverage Philosophy

- 80% (lines, functions, statements, branches) is a floor, not a target, and
  must never be lowered without explicit human approval and a written
  reason.
- Branch coverage matters most: cover both sides of every conditional, not
  only the line.
- `vitest.config.ts`'s `coverage.include` is `src/**/*.ts`, so a file with no
  test still counts as 0% instead of disappearing from the denominator. Do
  not add a file to the coverage exclude list to move a number up.

<!-- profile:node-cli:start -->

- `src/bin.ts` is deliberately at 0% unit coverage: it is a process-binding
  shim, all its logic lives in `src/cli.ts` (which is unit-tested), and
  `bin.ts` itself is exercised end-to-end by `tests/cli.test.ts` and the
  tarball smoke test (`pnpm package:smoke`).

<!-- profile:node-cli:end -->

- Don't write a trivial test just to move the percentage; add a real edge
  case or error path instead.

## Anti-Patterns

- Don't test getters or trivial property access while skipping
  business-logic edge cases.
- Don't assert `toBeDefined()`/`not.toBeNull()` when a specific value is
  checkable.
- Don't share mutable fixture objects between tests.
- Don't test that a dependency works (for example, that `JSON.parse` parses
  JSON).
- Don't mock everything — a test that runs the real `withTimeout` against
  fake timers catches real bugs that an all-mocked version would miss.
