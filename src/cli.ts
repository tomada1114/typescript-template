import { InvalidInputError } from "./errors.js";
import { normalizeIdentifier, type NormalizeIdentifierOptions } from "./identifier.js";

/**
 * Output and environment the CLI is allowed to touch.
 *
 * @remarks
 * Everything the CLI needs from the outside world arrives here, so `runCli` is
 * a pure function of its arguments and can be tested without spawning a
 * process or capturing global streams. `src/bin.ts` supplies the real
 * implementation.
 */
export interface CliIo {
  /** Write one line to standard output. */
  readonly stdout: (line: string) => void;
  /** Write one line to standard error. */
  readonly stderr: (line: string) => void;
  /** Version reported by `--version`, read from the installed package.json. */
  readonly version: string;
}

/** Exit code returned when the request was understood but rejected. */
const EXIT_REJECTED = 1;
/** Exit code returned when the command line itself was wrong. */
const EXIT_USAGE = 2;

const USAGE = `Usage: my-package <command> [options]

Commands:
  normalize <text>      Print <text> as a normalized identifier
  help                  Show this message
  version               Show the installed version

Options for normalize:
  --separator <char>    Single non-alphanumeric character used to join words
                        (default: "-")
  --max-length <n>      Truncate the result to at most <n> characters
  --keep-case           Do not lowercase the result

Exit codes:
  0  success
  1  the input was understood but rejected
  2  usage error`;

/** A parse failure, carrying the message to print before exiting with 2. */
class UsageError extends Error {}

interface ParsedOptions {
  readonly text: string;
  readonly options: NormalizeIdentifierOptions;
}

/**
 * Split `--flag=value` into its parts, leaving other tokens alone.
 *
 * @returns The flag name and its inline value, or undefined when absent.
 */
function splitInlineValue(token: string): { flag: string; value?: string } {
  const equals = token.indexOf("=");
  if (equals === -1) {
    return { flag: token };
  }
  return { flag: token.slice(0, equals), value: token.slice(equals + 1) };
}

/**
 * Parse the arguments of the `normalize` command.
 *
 * @throws UsageError when the command line is malformed.
 */
function parseNormalize(args: readonly string[]): ParsedOptions {
  let text: string | undefined;
  let separator: string | undefined;
  let maxLength: number | undefined;
  let lowercase = true;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";

    if (!token.startsWith("--")) {
      if (text !== undefined) {
        throw new UsageError(`unexpected argument: ${token}`);
      }
      text = token;
      continue;
    }

    const { flag, value: inline } = splitInlineValue(token);

    /** Read this flag's value from `=value` or the next argument. */
    const takeValue = (): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = args[index + 1];
      if (next === undefined) {
        throw new UsageError(`${flag} requires a value`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--separator":
        separator = takeValue();
        break;
      case "--max-length": {
        const raw = takeValue();
        const parsed = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(parsed)) {
          throw new UsageError(`--max-length requires a number, received: ${raw}`);
        }
        maxLength = parsed;
        break;
      }
      case "--keep-case":
        lowercase = false;
        break;
      default:
        throw new UsageError(`unknown option: ${flag}`);
    }
  }

  if (text === undefined) {
    throw new UsageError("normalize requires <text>");
  }

  // Built conditionally because exactOptionalPropertyTypes forbids passing an
  // explicit `undefined` for an optional property.
  return {
    text,
    options: {
      lowercase,
      ...(separator === undefined ? {} : { separator }),
      ...(maxLength === undefined ? {} : { maxLength }),
    },
  };
}

/**
 * Run the command line and report the process exit code.
 *
 * @remarks
 * Never throws and never calls `process.exit`: the caller decides what to do
 * with the returned code. Usage problems and rejected input are distinguished
 * by exit code so scripts can tell "you called me wrong" (2) from "your data
 * was not acceptable" (1).
 *
 * @param argv - Arguments after the executable and script path.
 * @param io - See {@link CliIo}.
 * @returns The process exit code.
 */
export function runCli(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv;

  if (command === undefined) {
    io.stderr(USAGE);
    return EXIT_USAGE;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return 0;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    io.stdout(io.version);
    return 0;
  }

  if (command !== "normalize") {
    io.stderr(`error: unknown command: ${command}`);
    io.stderr(USAGE);
    return EXIT_USAGE;
  }

  let parsed: ParsedOptions;
  try {
    parsed = parseNormalize(rest);
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    io.stderr(`error: ${error.message}`);
    io.stderr(USAGE);
    return EXIT_USAGE;
  }

  try {
    io.stdout(normalizeIdentifier(parsed.text, parsed.options));
    return 0;
  } catch (error) {
    if (!(error instanceof InvalidInputError)) {
      throw error;
    }
    io.stderr(`error [${error.code}] ${error.field}: ${error.message}`);
    return EXIT_REJECTED;
  }
}
