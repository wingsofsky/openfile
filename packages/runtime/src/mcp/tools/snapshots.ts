/** MCP 工具：影子快照：列、拍、看变化、diff。 */
import { z } from "zod";
import { resolveScoped } from "../../lib/scoped.mjs";

import { ROOT, shadow } from "../context.ts";
import { ok, fail, guard, type ToolScope } from "../tool-kit.ts";

export function registerSnapshotsTools({ registerTool }: ToolScope): void {
  registerTool(
    "list_snapshots",
    {
      title: "列快照",
      description: "影子仓库的快照时间线（新→旧；与桌面 app 的版本时间线同源）",
      inputSchema: { limit: z.number().int().positive().max(500).default(30) },
    },
    guard(async ({ limit }: { limit: number }) => {
      const sh = await shadow();
      if (!sh.sg) return fail(sh.reason ?? "版本层不可用");
      return ok(await sh.sg.list(limit));
    }),
  );

  registerTool(
    "snapshot_now",
    {
      title: "打快照",
      description: "立即为整个文库打一个影子快照（大改动前自保）；无变化返回 null",
      inputSchema: { label: z.string().max(120).default("agent 快照") },
    },
    guard(async ({ label }: { label: string }) => {
      const sh = await shadow();
      if (!sh.sg) return fail(sh.reason ?? "版本层不可用");
      return ok((await sh.sg.snapshot(label)) ?? { changed: false });
    }),
  );

  registerTool(
    "snapshot_changes",
    {
      title: "快照变更清单",
      description: "某个快照相对其父版本改了哪些文件",
      inputSchema: { id: z.string().describe("快照 id，来自 list_snapshots") },
    },
    guard(async ({ id }: { id: string }) => {
      const sh = await shadow();
      if (!sh.sg) return fail(sh.reason ?? "版本层不可用");
      return ok(await sh.sg.changes(id));
    }),
  );

  registerTool(
    "diff_since",
    {
      title: "自快照以来的 diff",
      description:
        "某快照 → 当前磁盘内容的统一 diff：那个快照之后文库发生了什么",
      inputSchema: {
        snapshot: z.string(),
        path: z.string().optional().describe("只看这个文件；省略 = 全库"),
      },
    },
    guard(async ({ snapshot: id, path: rel }: { snapshot: string; path?: string }) => {
      const sh = await shadow();
      if (!sh.sg) return fail(sh.reason ?? "版本层不可用");
      if (rel !== undefined) resolveScoped(ROOT, rel); // 出证（路径注入 git 参数前先验）
      let diff = await sh.sg.diffSince(id, rel);
      const CAP = 512 * 1024;
      if (diff.length > CAP) diff = diff.slice(0, CAP) + "\n…（diff 超过 512KB 已截断，用 path 参数按文件看）";
      return ok(diff || "（无差异）");
    }),
  );
}
