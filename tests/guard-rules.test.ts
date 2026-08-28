import { describe, expect, it } from "vitest";

import { checkCredentials } from "../scripts/lib/guard/credentials.mjs";
import { checkRead } from "../scripts/lib/guard/paths.mjs";

// Pure-function coverage for the secret-detection rules under
// scripts/lib/guard/, used by scripts/check-staged.mjs. Nothing here spawns a
// process — tests/check-staged.test.ts covers that caller's own contract
// (staged content, exit codes).
//
// Secret-shaped fixtures are assembled from fragments rather than written
// out. A literal token or key header in this file would be a real finding
// for every secret scanner pointed at the repository.
function secretShaped(...parts: string[]): string {
  return parts.join("");
}

describe("paths: checkRead", () => {
  it("blocks reading a dotenv file", () => {
    expect(checkRead(".env")).toMatch(/\.env\*/);
  });

  it("allows reading the env example", () => {
    expect(checkRead(".env.example")).toBeNull();
  });

  it("blocks a path under secrets/", () => {
    expect(checkRead("secrets/token.txt")).toMatch(/secrets\//);
  });
});

describe("credentials: checkCredentials", () => {
  const privateKey = secretShaped("-----BEGIN RSA ", "PRIVATE ", "KEY-----");

  it("blocks a private key", () => {
    expect(checkCredentials(`${privateKey}\nMIIE…\n`)).toMatch(/private key/);
  });

  it("does not flag ordinary prose", () => {
    expect(
      checkCredentials("Store the token in the environment, never in a file."),
    ).toBeNull();
  });

  it("blocks a hardcoded password assignment", () => {
    expect(checkCredentials(secretShaped("password ", "= ", '"s3cr3t-value"'))).toMatch(
      /password/,
    );
  });

  it("does not flag prose that merely mentions a password", () => {
    expect(
      checkCredentials("Store the password in a secret manager, never in a file."),
    ).toBeNull();
  });

  it("blocks a GitHub fine-grained personal access token", () => {
    expect(
      checkCredentials(
        secretShaped("github_pat_", "11AAAAAAA0AAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAA"),
      ),
    ).toMatch(/fine-grained/);
  });

  it("does not flag a plain github_pat-shaped word that is too short", () => {
    expect(checkCredentials("github_pat_expired")).toBeNull();
  });

  it("blocks a GitHub App installation JWT", () => {
    const jwt = secretShaped(
      "eyJhbGciOiJIUzI1NiJ9.",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    );
    expect(checkCredentials(jwt)).toMatch(/JSON Web Token/);
  });

  it("does not flag a dotted string that is not JWT-shaped", () => {
    expect(checkCredentials("release.eyJust.a.version-like.string")).toBeNull();
  });

  it("blocks an AWS secret access key assignment", () => {
    const secret = secretShaped(
      "aws_secret_access_key = ",
      '"wJalrXUtnFEMI/K7MDENG',
      '/bPxRfiCYEXAMPLEKEY"',
    );
    expect(checkCredentials(secret)).toMatch(/AWS secret access key/);
  });

  it("does not flag a bare 40-character string with no AWS context", () => {
    const lookalike = secretShaped("wJalrXUtnFEMI/K7MDENG", "/bPxRfiCYEXAMPLEKEY");
    expect(checkCredentials(lookalike)).toBeNull();
  });

  it("does not flag a lowercase-only 40-character hex string (e.g. a git SHA)", () => {
    expect(checkCredentials("447392e1a2b3c4d5e6f7890123456789abcdef01")).toBeNull();
  });

  it("blocks an Anthropic API key", () => {
    expect(checkCredentials(secretShaped("sk-ant-", "a".repeat(25)))).toMatch(
      /Anthropic/,
    );
  });

  it("does not flag a short sk-ant-shaped string", () => {
    expect(checkCredentials("sk-ant-expired")).toBeNull();
  });

  it("blocks an OpenAI project API key", () => {
    expect(checkCredentials(secretShaped("sk-proj-", "a".repeat(25)))).toMatch(
      /OpenAI/,
    );
  });

  it("blocks a classic OpenAI API key", () => {
    expect(checkCredentials(secretShaped("sk-", "a".repeat(25)))).toMatch(/OpenAI/);
  });

  it("does not flag a short sk- prefixed string", () => {
    expect(checkCredentials("sk-expired")).toBeNull();
  });

  it("blocks a Slack token", () => {
    expect(checkCredentials(secretShaped("xoxb-", "1".repeat(15)))).toMatch(/Slack/);
  });

  it("does not flag a short xoxb-shaped string", () => {
    expect(checkCredentials("xoxb-revoked")).toBeNull();
  });

  it("blocks a Google API key", () => {
    expect(checkCredentials(secretShaped("AIza", "a".repeat(35)))).toMatch(/Google/);
  });

  it("does not flag a short AIza-prefixed string", () => {
    expect(checkCredentials("AIzaExpired")).toBeNull();
  });

  it("blocks a Stripe live API key", () => {
    expect(checkCredentials(secretShaped("sk_live_", "a".repeat(20)))).toMatch(
      /Stripe/,
    );
  });

  it("does not flag a Stripe test key", () => {
    expect(checkCredentials(secretShaped("sk_test_", "a".repeat(20)))).toBeNull();
  });
});
