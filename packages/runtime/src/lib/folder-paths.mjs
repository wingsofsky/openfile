import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
export function folderAppData() {
  if (process.env.OPENFILE_APPDATA) return process.env.OPENFILE_APPDATA;
  const userHome = os.homedir(), id = "com.wingsofsky.openfile";
  if (process.platform === "darwin") return path.join(userHome, "Library/Application Support", id);
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(userHome, "AppData/Roaming"), id);
  return path.join(process.env.XDG_DATA_HOME ?? path.join(userHome, ".local/share"), id);
}
// Namespace only, not authorization. Git blob hash of the root path; existing session archives are keyed by it, so keep it stable.
export function folderTargetKey(root) {
  const bytes = Buffer.from(root, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
