// One-shot migration: populate content_hash for every existing scores row.
//
// Strategy per row:
//   1. If the original filepath still exists → hash it.
//   2. Else, recursively search ./creatives/ for a file with the same basename;
//      if exactly one match, hash it and update both content_hash and filepath
//      so the DB stays consistent with where the file actually lives.
//   3. Else → orphan: leave content_hash NULL, report the row.
//
// Idempotent: only touches rows where content_hash IS NULL.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { ScoreDB, computeContentHash } from "../db.js";

const DB_PATH = process.env.DB_PATH || "./data/scores.db";
const SEARCH_ROOT = "./creatives";

function findByFilename(root: string, target: string): string[] {
  const matches: string[] = [];
  if (!fs.existsSync(root)) return matches;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name === target) matches.push(path.resolve(full));
    }
  }
  return matches;
}

function main() {
  const db = new ScoreDB(DB_PATH);
  const rows = db.rowsMissingContentHash();
  console.log(`Found ${rows.length} row(s) missing content_hash.\n`);

  let migrated = 0;
  let orphaned = 0;
  const orphans: { id: number; filename: string; filepath: string }[] = [];
  const relocated: { id: number; filename: string; from: string; to: string }[] = [];

  for (const row of rows) {
    // 1. Original location
    if (fs.existsSync(row.filepath)) {
      const hash = computeContentHash(row.filepath);
      db.setContentHash(row.id, hash);
      migrated++;
      console.log(`  ✓ id=${row.id} ${row.filename} → ${hash.slice(0, 12)}…`);
      continue;
    }

    // 2. Recursive fallback by basename
    const matches = findByFilename(SEARCH_ROOT, row.filename);
    if (matches.length === 1) {
      const newPath = matches[0];
      const hash = computeContentHash(newPath);
      db.setContentHash(row.id, hash, newPath);
      migrated++;
      relocated.push({ id: row.id, filename: row.filename, from: row.filepath, to: newPath });
      console.log(
        `  ✓ id=${row.id} ${row.filename} (relocated) → ${hash.slice(0, 12)}…`
      );
      continue;
    }
    if (matches.length > 1) {
      // Ambiguous — don't guess, treat as orphan with a clearer message.
      orphaned++;
      orphans.push(row);
      console.log(
        `  ⚠ id=${row.id} ${row.filename} — AMBIGUOUS (${matches.length} matches under ${SEARCH_ROOT})`
      );
      continue;
    }

    // 3. Orphan
    orphaned++;
    orphans.push(row);
    console.log(`  ✗ id=${row.id} ${row.filename} — file gone (was at ${row.filepath})`);
  }

  console.log(`\n✓ migrated ${migrated}, orphaned ${orphaned}`);

  if (relocated.length > 0) {
    console.log(`\nRelocated rows (filepath updated to new location):`);
    for (const r of relocated) {
      console.log(`  id=${r.id} ${r.filename}`);
      console.log(`    from: ${r.from}`);
      console.log(`    to:   ${r.to}`);
    }
  }

  if (orphans.length > 0) {
    console.log(`\nOrphan rows (content_hash still NULL — file not found anywhere under ${SEARCH_ROOT}):`);
    for (const o of orphans) {
      console.log(`  id=${o.id} ${o.filename} (last known: ${o.filepath})`);
    }
  }

  db.close();
}

main();
