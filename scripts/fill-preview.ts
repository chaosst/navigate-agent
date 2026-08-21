#!/usr/bin/env node
/**
 * 为迁移的 zyplayer-doc 页面填充 preview 字段（Markdown → HTML）。
 * 一次性脚本，迁移完成后可删除。
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cfg = {
  host: process.env.ZYPLAYER_MYSQL_HOST || "localhost",
  port: parseInt(process.env.ZYPLAYER_MYSQL_PORT || "3307", 10),
  user: process.env.ZYPLAYER_MYSQL_USER || "zyplayer",
  password: process.env.ZYPLAYER_MYSQL_PASSWORD || "zyplayer_pass",
  database: process.env.ZYPLAYER_MYSQL_DB || "zyplayer_doc",
};

function renderMarkdown(md: string): string {
  const inFile = join(tmpdir(), "zp-preview-in.md");
  writeFileSync(inFile, md, "utf-8");
  const out = execSync(
    `python -c "import markdown,sys;sys.stdout.reconfigure(encoding='utf-8');print(markdown.markdown(open(r'${inFile.replace(/\\/g, "\\\\")}',encoding='utf-8').read(),extensions=['extra','codehilite','tables','fenced_code','sane_lists']))"`,
    { encoding: "utf-8" },
  );
  return out.trim();
}

async function main() {
  const conn = await mysql.createConnection(cfg);
  const [rows] = await conn.execute(
    "SELECT page_id, content, preview FROM wiki_page_content WHERE preview IS NULL",
  );
  console.log(`找到 ${(rows as mysql.RowDataPacket[]).length} 篇缺少 preview 的页面`);

  let ok = 0;
  for (const r of rows as mysql.RowDataPacket[]) {
    try {
      const md = (r.content as string) || "";
      const html = renderMarkdown(md);
      await conn.execute("UPDATE wiki_page_content SET preview=? WHERE page_id=?", [
        html,
        r.page_id,
      ]);
      console.log(`  ✅ page ${r.page_id} (${html.length} chars)`);
      ok++;
    } catch (e) {
      console.log(`  ❌ page ${r.page_id}: ${(e as Error).message}`);
    }
  }
  console.log(`完成: ${ok}/${(rows as mysql.RowDataPacket[]).length}`);
  await conn.end();
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
