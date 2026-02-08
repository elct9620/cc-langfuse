import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    assert.equal(pkg.type, "module");
  });

  it("has bin field pointing to bin/cli.js", () => {
    assert.deepEqual(pkg.bin, { "cc-langfuse": "./bin/cli.js" });
  });
});

describe("bin/cli.js", () => {
  it("has a node shebang on the first line", () => {
    const firstLine = readFileSync(cliBin, "utf8").split("\n")[0];
    assert.equal(firstLine, "#!/usr/bin/env node");
  });

  it("is executable", () => {
    assert.doesNotThrow(() => accessSync(cliBin, constants.X_OK));
  });

  it("outputs package name and version", () => {
    const output = execFileSync("node", [cliBin], { encoding: "utf8" }).trim();
    assert.equal(output, `${pkg.name} v${pkg.version}`);
  });
});
