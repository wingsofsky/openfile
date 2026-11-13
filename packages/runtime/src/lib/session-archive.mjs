/**
 * 内嵌会话档案的应用数据落点：打开的文件夹还不是文库（根下没有 .openfile/）时，档案不写进这个文件夹，
 * 写到应用数据目录的 sessions/<键>/。键是根路径的哈希（folder-paths.mjs，只作命名空间、不是授权；已有档案按它存放，不能改），
 * target.json 记下绑定的文库根，哈希撞上别的根就拒绝。是文库时档案照旧写进 `会话/内嵌/`（workspace.ts），不经过这里。
 *
 * 档案名只能是会话控制器生成的「ISO 时间（冒号和点换成 -）-UUID.md」，别的名字一律拒绝；落盘仍经 scoped.mjs 出证。
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile, readTextScoped, resolveScoped, resolveWritePathCreating } from "./scoped.mjs";
import { folderTargetKey } from "./folder-paths.mjs";

const ARCHIVE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;
const failure = (status, message) => Object.assign(new Error(message), { status });

/** 文库 = 根下有 .openfile 目录（与 open_target.rs 推断工作区用的标记相同） */
export function isLibraryRoot(root) {
  try {
    return fs.statSync(path.join(root, ".openfile")).isDirectory();
  } catch {
    return false;
  }
}

function isArchiveName(name) {
  return typeof name === "string" && ARCHIVE_NAME.test(name);
}

/** 这个文库根的档案目录（root 是宿主规范化过的库根）；create = false 且还没建过时给 null */
function archiveDir(appData, root, create) {
  const rel = `sessions/${folderTargetKey(root)}`;
  const bindRel = `${rel}/target.json`;
  if (!fs.existsSync(appData)) {
    if (!create) return null;
    fs.mkdirSync(appData, { recursive: true });
  }
  let bound;
  try {
    bound = JSON.parse(fs.readFileSync(resolveScoped(appData, bindRel), "utf8")).target;
  } catch (e) {
    if (e.status !== 404) throw e;
    if (!create) return null;
    atomicWriteFile(resolveWritePathCreating(appData, bindRel), JSON.stringify({ version: 1, target: root }) + "\n");
    bound = root;
  }
  if (bound !== root) throw failure(409, "会话档案目录的文库绑定不一致");
  return resolveScoped(appData, rel);
}

/** expectedContent：null = 只新建；字符串 = 磁盘上的完整 UTF-8 基线（与 fs.write 同语义） */
export function writeSessionArchive(appData, root, name, content, expectedContent) {
  if (!isArchiveName(name)) throw failure(400, "会话档案名无效");
  if (typeof content !== "string") throw failure(400, "缺少 content");
  if (!(expectedContent === null || typeof expectedContent === "string")) throw failure(400, "非法写入基线");
  const dir = archiveDir(appData, root, true);
  const target = resolveWritePathCreating(dir, name);
  if (expectedContent === null) {
    if (fs.existsSync(target)) throw failure(409, "档案已存在，未覆盖。");
  } else if (!fs.readFileSync(resolveScoped(dir, name)).equals(Buffer.from(expectedContent, "utf8"))) {
    throw failure(409, "档案已更改，未覆盖。");
  }
  atomicWriteFile(target, content);
}

/** 只读：没建过就是空，不建目录；只列合格档案名的普通文件（符号链接、子目录、杂项都不列） */
export function listSessionArchives(appData, root) {
  const dir = archiveDir(appData, root, false);
  if (!dir) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !isArchiveName(ent.name)) continue;
    const st = fs.statSync(path.join(dir, ent.name));
    out.push({ name: ent.name, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

export function readSessionArchive(appData, root, name, maxBytes) {
  if (!isArchiveName(name)) throw failure(400, "会话档案名无效");
  const dir = archiveDir(appData, root, false);
  if (!dir) throw failure(404, "路径不可访问");
  return readTextScoped(dir, name, maxBytes);
}
