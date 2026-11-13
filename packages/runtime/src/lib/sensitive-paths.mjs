/** Single rule table for snapshots taken by the desktop app, browser mode and the MCP server. */
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import patterns from "./sensitive-paths.json" with { type: "json" };
import { canonicalRoot, resolveScoped, SKIP_DIRS } from "./scoped.mjs";
import { gitBinary, gitEnv } from "./git-bin.mjs";

export const SENSITIVE_PATH_PATTERNS = Object.freeze(patterns);
const rules = patterns.map((p) => ({
  rooted: p.includes("/"),
  re: new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`, "i"),
}));

/** Git-ignore subset: only * wildcards; patterns without / match any path segment. */
export function isSensitivePath(rel) {
  const parts = rel.replaceAll("\\", "/").split("/").filter((p) => p && p !== ".");
  return rules.some(({ rooted, re }) => rooted
    ? parts.some((_, i) => re.test(parts.slice(0, i + 1).join("/")))
    : parts.some((part) => re.test(part)));
}

// Explicit excludes cannot be overridden by a library's .gitignore negation.
const SNAPSHOT_PATHSPECS = [".", ...patterns.flatMap((p) => {
  // An exact excluded ignored filename still triggers git-add's explicit-path error.
  // A one-character class keeps identical matching while making it a glob pathspec.
  const pattern = p.includes("*") ? p : p.replace(/(.)$/, "[$1]");
  const glob = p.includes("/") ? pattern : `**/${pattern}`;
  return [`:(exclude,glob,icase)${glob}`, `:(exclude,glob,icase)${glob}/**`];
})];

/** Remove already-tracked sensitive entries from the index before add: never delete working files or rewrite history. */
export async function stageSafeSnapshot(g, root) {
  const tracked = (await g("ls-files", "--stage", "-z")).split("\0").filter(Boolean)
    .map((line) => { const tab = line.indexOf("\t"); return { mode: line.slice(0, 6), rel: line.slice(tab + 1) }; });
  const nested = [], files = [];
  const walk = (rel, inProject = false) => {
    const entries = fs.readdirSync(resolveScoped(root, rel), { withFileTypes: true });
    const project = inProject || (!!rel && entries.some((e) => e.name === ".git"));
    if (project && !inProject) nested.push(rel);
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || SKIP_DIRS.has(e.name) || ["target", "dist"].includes(e.name) || isSensitivePath(child)) continue;
      if (e.isDirectory()) walk(child, project);
      else if (project && e.isFile()) files.push(child);
    }
  };
  walk("");
  const inNested = (rel) => nested.some((dir) => rel === dir || rel.startsWith(dir + "/"));
  const remove = tracked.filter(({ mode, rel }) => mode === "160000" || isSensitivePath(rel) || inNested(rel)).map(({ rel }) => rel);
  for (let i = 0; i < remove.length; i += 100) await g("update-index", "--force-remove", "--", ...remove.slice(i, i + 100));
  // Exclude repositories before git-add so an unborn nested HEAD cannot fail it.
  await g("add", "-A", "--", ...SNAPSHOT_PATHSPECS, ...nested.map((rel) => `:(exclude,literal)${rel}`));
  if (files.length) {
    const shadow = (await g("rev-parse", "--absolute-git-dir")).trim();
    const ignored = await new Promise((resolve, reject) => {
      const child = execFile(gitBinary(), ["--git-dir", shadow, "--work-tree", root, "check-ignore", "--no-index", "--stdin", "-z"],
        { maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: gitEnv() }, (error, stdout) => {
          if (error && error.code !== 1) reject(error); else resolve(stdout);
        });
      child.stdin.on("error", () => {}); // exit callback reports command failures
      child.stdin.end(files.join("\0") + "\0");
    });
    const excluded = new Set(ignored.split("\0"));
    for (const rel of files.filter((p) => !excluded.has(p))) {
      const abs = resolveScoped(root, rel);
      const stat = fs.lstatSync(abs);
      if (!stat.isFile()) throw new Error("快照文件在读取期间发生变化");
      const oid = (await g("hash-object", "-w", "--", abs)).trim();
      const mode = stat.mode & 0o111 ? "100755" : "100644";
      await g("update-index", "--add", "--cacheinfo", `${mode},${oid},${rel}`);
    }
  }
}

export function assertSafeSnapshotRestore(root, rel) {
  if (typeof rel !== "string" || isSensitivePath(rel)) throw new Error("本机认证状态与凭据不能从文档快照恢复");
  let probe = rel;
  const suffix = [];
  for (;;) {
    let abs;
    try { abs = resolveScoped(root, probe); } catch (e) {
      if (e.status !== 404 || !probe || probe === ".") throw e;
      suffix.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) throw e; // 防原地打转（如 Windows 的 "C:" 的 dirname 还是它自己）
      probe = parent === "." ? "" : parent;
      continue;
    }
    const target = path.join(abs, ...suffix);
    if (isSensitivePath(path.relative(canonicalRoot(root), target))) throw new Error("本机认证状态与凭据不能从文档快照恢复");
    let control;
    try { control = resolveScoped(root, ".openfile"); } catch { return; }
    if (target === control || target.startsWith(control + path.sep)) {
      if (isSensitivePath(`.openfile/${path.relative(control, target)}`)) throw new Error("本机认证状态与凭据不能从文档快照恢复");
    }
    return;
  }
}
