import { describe, it, expect } from "vitest";
import { readFileSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const cliBin = join(root, "bin", "cli.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("package.json", () => {
  it('has type set to "module"', () => {
    expect(pkg.type).toBe("module");
  });

  it("has bin field pointing to bin/cli.js", () => {
    expect(pkg.bin).toEqual({ "cc-langfuse": "./bin/cli.js" });
  });
});

describe("bin/cli.js", () => {
  it("has a node shebang on the first line", () => {
    const firstLine = readFileSync(cliBin, "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("is executable", () => {
    expect(() => accessSync(cliBin, constants.X_OK)).not.toThrow();
  });

  it("exits silently without TRACE_TO_LANGFUSE", () => {
    const output = execFileSync("node", [cliBin], {
      encoding: "utf8",
      env: { ...process.env, TRACE_TO_LANGFUSE: undefined },
    }).trim();
    expect(output).toBe("");
  });
});
