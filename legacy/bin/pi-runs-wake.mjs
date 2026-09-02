#!/usr/bin/env node
import { refreshRun } from "../src/core.mjs";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: pi-runs-wake <run_id>");
  process.exit(2);
}

const rec = await refreshRun(runId);
console.log(JSON.stringify({ run_id: rec.run_id, status: rec.status, exit_code: rec.exit_code ?? null }));
