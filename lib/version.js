// Which build of Strata is running (for /strata detail): the package version,
// the commit when one can be found, and a hash of the code files.
//
// - link: / local checkout: the package folder is a git checkout; HEAD is read
//   from .git (worktrees too), no git binary needed.
// - `dsh plugin add github:…`: DSH installs with pnpm from a codeload tarball,
//   so the folder has no .git; the commit is in the profile's pnpm-lock.yaml
//   (`@lightcheng/dsh-strata@https://codeload.github.com/…/tar.gz/<sha>`), or a
//   package-lock.json `resolved: git+…#<sha>`.
// - npm registry: the lock names the version only ("npm release").
// The code hash (sha256 over the shipped .js files, line endings normalized)
// is the build mark that tells two installs of the same version apart even
// when no commit is found.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "@lightcheng/dsh-strata";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODE_FILES = ["shell.js", "client.js", "index.js", "gate.js", "plan.js", "raw.js", "shadow.js", "thunder.js", "tools-plugin.js"];

let cached = null;

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** HEAD commit of a git checkout at `dir` (a .git folder or a worktree's `gitdir:` file), or "". */
export function gitHead(dir) {
  try {
    let git = join(dir, ".git");
    if (!existsSync(git)) return "";
    if (statSync(git).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(read(git) || "")?.[1]?.trim();
      if (!pointer) return "";
      git = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
    }
    const head = (read(join(git, "HEAD")) || "").trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
    const ref = /^ref:\s*(\S+)/.exec(head)?.[1];
    if (!ref) return "";
    // A worktree keeps refs in the common dir.
    const common = (read(join(git, "commondir")) || "").trim();
    const dirs = [git, ...(common ? [isAbsolute(common) ? common : resolve(git, common)] : [])];
    for (const base of dirs) {
      const loose = (read(join(base, ref)) || "").trim();
      if (/^[0-9a-f]{40}$/i.test(loose)) return loose.toLowerCase();
    }
    for (const base of dirs) {
      const packed = read(join(base, "packed-refs")) || "";
      const line = packed.split("\n").find((item) => item.endsWith(` ${ref}`));
      const sha = line?.split(" ")[0];
      if (sha && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
    }
  } catch {}
  return "";
}

/**
 * How the nearest lock file above `dir` resolved this package.
 * @returns {{ source: "github" | "npm" | "", commit: string }}
 */
export function lockSource(dir, name = NAME) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let at = dir;
  for (let depth = 0; depth < 8; depth += 1) {
    const pnpm = read(join(at, "pnpm-lock.yaml"));
    if (pnpm && pnpm.includes(name)) {
      const sha = new RegExp(`${escaped}@[^'"\\s]*?tar\\.gz/([0-9a-f]{40})`, "i").exec(pnpm)?.[1];
      if (sha) return { source: "github", commit: sha.toLowerCase() };
      if (new RegExp(`${escaped}@\\d+\\.\\d+\\.\\d+`).test(pnpm)) return { source: "npm", commit: "" };
    }
    const npm = read(join(at, "package-lock.json"));
    if (npm && npm.includes(name)) {
      const block = new RegExp(`"node_modules/${escaped}"\\s*:\\s*\\{[^}]*?"resolved"\\s*:\\s*"([^"]*)"`).exec(npm)?.[1] || "";
      const sha = /#([0-9a-f]{40})$/i.exec(block)?.[1];
      if (sha) return { source: "github", commit: sha.toLowerCase() };
      if (/registry\.npmjs\.org|\.tgz$/.test(block)) return { source: "npm", commit: "" };
    }
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return { source: "", commit: "" };
}

/** sha256 (first 8 hex) over the shipped code files, CRLF normalized. */
export function codeHash(root = ROOT) {
  const hash = createHash("sha256");
  let lib = [];
  try {
    lib = readdirSync(join(root, "lib")).filter((name) => name.endsWith(".js")).sort().map((name) => `lib/${name}`);
  } catch {}
  for (const file of [...CODE_FILES, ...lib]) {
    const text = read(join(root, file));
    if (text === null) continue;
    hash.update(`${file}\0${text.replace(/\r\n/g, "\n")}\0`);
  }
  return hash.digest("hex").slice(0, 8);
}

/**
 * @param {string} [root] - package folder (tests)
 * @returns {{ version: string, commit: string, source: "git" | "github" | "npm" | "", code: string }}
 */
export function buildInfo(root) {
  if (!root && cached) return cached;
  const dir = root || ROOT;
  let version = "";
  try {
    version = JSON.parse(read(join(dir, "package.json")) || "{}").version || "";
  } catch {}
  const head = gitHead(dir);
  const lock = head ? { source: "", commit: "" } : lockSource(dir);
  const info = {
    version,
    commit: head || lock.commit,
    source: head ? "git" : lock.source,
    code: codeHash(dir),
  };
  if (!root) cached = info;
  return info;
}
