import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { storePath, runDir, runsHome } from "./paths.mjs";

async function ensureHome() {
  await mkdir(runsHome(), { recursive: true });
}

export async function loadAll() {
  await ensureHome();
  try {
    const raw = await readFile(storePath(), "utf8");
    const rows = [];
    for (const line of raw.split(/\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip corrupt line */
      }
    }
    const byId = new Map();
    for (const row of rows) {
      if (row && row.run_id) byId.set(row.run_id, row);
    }
    return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function getRun(runId) {
  const all = await loadAll();
  return all.find((r) => r.run_id === runId) || null;
}

export async function upsertRun(record) {
  await ensureHome();
  await mkdir(runDir(record.run_id), { recursive: true });
  record.updated_at = new Date().toISOString();
  const all = await loadAll();
  const next = all.filter((r) => r.run_id !== record.run_id);
  next.push(record);
  const tmp = storePath() + ".tmp";
  const body = next.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, storePath());
  return record;
}

export async function appendEvent(runId, event) {
  await ensureHome();
  const line = JSON.stringify({ run_id: runId, at: new Date().toISOString(), ...event }) + "\n";
  await appendFile(storePath().replace(/runs\.jsonl$/, "events.jsonl"), line, "utf8");
}

export { storePath, runDir, runsHome };
