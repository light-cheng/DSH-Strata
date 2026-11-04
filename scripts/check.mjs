// Syntax-check every shipped and test file.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const roots = [".", "lib", "test", "test/helpers", "eval", "scripts"];
let failed = 0;
for (const dir of roots) {
  for (const name of readdirSync(dir)) {
    if (!/\.(m?js)$/.test(name)) continue;
    const file = join(dir, name);
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      failed += 1;
      process.stderr.write(result.stderr);
    }
  }
}
if (failed) process.exit(1);
console.log("syntax ok");
