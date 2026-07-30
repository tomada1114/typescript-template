import { beforeEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/cli.js";

interface Recorder extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

function recorder(): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    version: "1.2.3",
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  };
}

let io: Recorder;

beforeEach(() => {
  io = recorder();
});

describe("runCli", () => {
  describe("usage and version", () => {
    it("prints usage to stderr and fails when no command is given", () => {
      expect(runCli([], io)).toBe(2);
      expect(io.out).toEqual([]);
      expect(io.err.join("\n")).toContain("Usage:");
    });

    it.each(["--help", "-h", "help"])("prints usage to stdout for %s", (flag) => {
      expect(runCli([flag], io)).toBe(0);
      expect(io.out.join("\n")).toContain("Usage:");
      expect(io.err).toEqual([]);
    });

    it.each(["--version", "-v", "version"])("prints the version for %s", (flag) => {
      expect(runCli([flag], io)).toBe(0);
      expect(io.out).toEqual(["1.2.3"]);
    });

    it("documents every command it accepts", () => {
      runCli(["--help"], io);
      const usage = io.out.join("\n");
      expect(usage).toContain("normalize");
      expect(usage).toContain("--separator");
      expect(usage).toContain("--max-length");
      expect(usage).toContain("--keep-case");
    });
  });

  describe("normalize", () => {
    it("prints the normalized identifier", () => {
      expect(runCli(["normalize", "Hello World"], io)).toBe(0);
      expect(io.out).toEqual(["hello-world"]);
      expect(io.err).toEqual([]);
    });

    it("accepts a separator as a separate argument", () => {
      expect(runCli(["normalize", "a b", "--separator", "_"], io)).toBe(0);
      expect(io.out).toEqual(["a_b"]);
    });

    it("accepts a separator in --flag=value form", () => {
      expect(runCli(["normalize", "a b", "--separator=_"], io)).toBe(0);
      expect(io.out).toEqual(["a_b"]);
    });

    it("keeps case when asked", () => {
      expect(runCli(["normalize", "Hello World", "--keep-case"], io)).toBe(0);
      expect(io.out).toEqual(["Hello-World"]);
    });

    it("truncates with --max-length", () => {
      expect(runCli(["normalize", "hello world", "--max-length", "5"], io)).toBe(0);
      expect(io.out).toEqual(["hello"]);
    });
  });

  describe("usage errors exit 2", () => {
    it("rejects an unknown command", () => {
      expect(runCli(["frobnicate"], io)).toBe(2);
      expect(io.err.join("\n")).toContain("frobnicate");
    });

    it("rejects a missing argument", () => {
      expect(runCli(["normalize"], io)).toBe(2);
      expect(io.err.join("\n")).toContain("<text>");
    });

    it("rejects extra positional arguments", () => {
      expect(runCli(["normalize", "a", "b"], io)).toBe(2);
      expect(io.err.join("\n")).toContain("unexpected");
    });

    it("rejects an unknown option", () => {
      expect(runCli(["normalize", "a b", "--bogus"], io)).toBe(2);
      expect(io.err.join("\n")).toContain("--bogus");
    });

    it("rejects an option that is missing its value", () => {
      expect(runCli(["normalize", "a b", "--separator"], io)).toBe(2);
      expect(io.err.join("\n")).toContain("--separator");
    });

    it("rejects a non-numeric --max-length", () => {
      expect(runCli(["normalize", "a b", "--max-length", "many"], io)).toBe(2);
      expect(io.err.join("\n")).toContain("--max-length");
    });

    it("never writes usage errors to stdout", () => {
      runCli(["normalize", "a b", "--bogus"], io);
      expect(io.out).toEqual([]);
    });
  });

  describe("rejected input exits 1", () => {
    it("reports the library error code and field", () => {
      expect(runCli(["normalize", "!!! ???"], io)).toBe(1);
      const message = io.err.join("\n");
      expect(message).toContain("ERR_INVALID_INPUT");
      expect(message).toContain("input");
      expect(io.out).toEqual([]);
    });

    it("reports a rejected separator", () => {
      expect(runCli(["normalize", "a b", "--separator", "xy"], io)).toBe(1);
      expect(io.err.join("\n")).toContain("options.separator");
    });

    it("reports a rejected max length", () => {
      expect(runCli(["normalize", "a b", "--max-length", "0"], io)).toBe(1);
      expect(io.err.join("\n")).toContain("options.maxLength");
    });
  });
});
