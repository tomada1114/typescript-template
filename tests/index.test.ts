import { describe, expect, it } from "vitest";

import { InvalidInputError, normalizeIdentifier } from "../src/index.js";

describe("normalizeIdentifier", () => {
  it("lowercases and joins words with the default separator", () => {
    expect(normalizeIdentifier("Hello World")).toBe("hello-world");
  });

  it("collapses runs of unsupported characters into a single separator", () => {
    expect(normalizeIdentifier("a  ---  b")).toBe("a-b");
  });

  it("trims leading and trailing separators", () => {
    expect(normalizeIdentifier("  !!Hello!!  ")).toBe("hello");
  });

  it("keeps digits and ASCII letters", () => {
    expect(normalizeIdentifier("Release v2 build 30")).toBe("release-v2-build-30");
  });

  it("replaces non-ASCII letters rather than dropping them silently", () => {
    expect(normalizeIdentifier("café außen")).toBe("caf-au-en");
  });

  it("preserves case when lowercase is disabled", () => {
    expect(normalizeIdentifier("Hello World", { lowercase: false })).toBe(
      "Hello-World",
    );
  });

  it("uses a custom separator", () => {
    expect(normalizeIdentifier("Hello World", { separator: "_" })).toBe("hello_world");
  });

  it("truncates to maxLength without leaving a trailing separator", () => {
    expect(normalizeIdentifier("hello world", { maxLength: 6 })).toBe("hello");
  });

  it("returns the input unchanged when it is already normalized", () => {
    expect(normalizeIdentifier("already-normalized")).toBe("already-normalized");
  });

  it("accepts a maxLength longer than the normalized value", () => {
    expect(normalizeIdentifier("hi", { maxLength: 100 })).toBe("hi");
  });

  describe("input rejection", () => {
    it("rejects an empty string", () => {
      expect(() => normalizeIdentifier("")).toThrow(InvalidInputError);
    });

    it("rejects a whitespace-only string", () => {
      expect(() => normalizeIdentifier("   \t\n ")).toThrow(InvalidInputError);
    });

    it("rejects input with no retainable characters", () => {
      expect(() => normalizeIdentifier("!!! ???")).toThrow(InvalidInputError);
    });

    it("reports the offending field and a stable error code", () => {
      try {
        normalizeIdentifier("");
        expect.unreachable("normalizeIdentifier should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidInputError);
        const invalid = error as InvalidInputError;
        expect(invalid.code).toBe("ERR_INVALID_INPUT");
        expect(invalid.field).toBe("input");
        expect(invalid.name).toBe("InvalidInputError");
        expect(invalid.message).toContain("input");
      }
    });
  });

  describe("option rejection", () => {
    it("rejects a multi-character separator", () => {
      expect(() => normalizeIdentifier("a b", { separator: "--" })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects an empty separator", () => {
      expect(() => normalizeIdentifier("a b", { separator: "" })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects a separator that normalization would strip again", () => {
      expect(() => normalizeIdentifier("a b", { separator: "x" })).toThrow(
        InvalidInputError,
      );
    });

    it.each(["/", "\\", ":", "\0", "\n", "💥"])(
      "rejects filename-unsafe separator %j",
      (separator) => {
        expect(() => normalizeIdentifier("a b", { separator })).toThrow(
          InvalidInputError,
        );
      },
    );

    it.each(["-", "_", ".", "~"])("accepts safe separator %j", (separator) => {
      expect(normalizeIdentifier("a b", { separator })).toBe(`a${separator}b`);
    });

    it("names the separator option in the error", () => {
      try {
        normalizeIdentifier("a b", { separator: "??" });
        expect.unreachable("normalizeIdentifier should have thrown");
      } catch (error) {
        const invalid = error as InvalidInputError;
        expect(invalid.field).toBe("options.separator");
        expect(invalid.message).toContain("-, _, ., ~");
      }
    });

    it("rejects a zero maxLength", () => {
      expect(() => normalizeIdentifier("a b", { maxLength: 0 })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects a negative maxLength", () => {
      expect(() => normalizeIdentifier("a b", { maxLength: -1 })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects a fractional maxLength", () => {
      expect(() => normalizeIdentifier("a b", { maxLength: 2.5 })).toThrow(
        InvalidInputError,
      );
    });

    it("rejects a non-finite maxLength", () => {
      expect(() => normalizeIdentifier("a b", { maxLength: Number.NaN })).toThrow(
        InvalidInputError,
      );
    });

    it("names the maxLength option in the error", () => {
      try {
        normalizeIdentifier("a b", { maxLength: 0 });
        expect.unreachable("normalizeIdentifier should have thrown");
      } catch (error) {
        expect((error as InvalidInputError).field).toBe("options.maxLength");
      }
    });

    it("still returns a usable identifier when maxLength cuts inside a word", () => {
      // The normalized value always starts with an alphanumeric character, so
      // truncation can shorten the result but never empty it.
      expect(normalizeIdentifier("!ab cd", { maxLength: 3 })).toBe("ab");
    });
  });
});

describe("InvalidInputError", () => {
  it("is an Error subclass with a captured stack", () => {
    const error = new InvalidInputError("input", "input must not be empty");
    expect(error).toBeInstanceOf(Error);
    expect(typeof error.stack).toBe("string");
  });
});
