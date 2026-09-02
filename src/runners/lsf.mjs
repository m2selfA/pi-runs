import { writeFile } from "node:fs/promises";
import { runCmd } from "../exec.mjs";
import { parseBsubOutput, parseBjobsLine, parseBhistExit } from "../parse.mjs";
import { renderLsfScript, scriptPath } from "../templates.mjs";

export async function submit(record, req) {
  const path = scriptPath(record);
  await writeFile(path, renderLsfScript(record, req), { encoding: "utf8", mode: 0o755 });
  const out = await runCmd("bsub", [path], { cwd: record.workdir });
  if (out.code !== 0) {
    throw new Error(`bsub failed: ${out.stderr || out.stdout}`);
  }
  const handle = parseBsubOutput(out.stdout + "\n" + out.stderr);
  if (!handle) throw new Error(`could not parse bsub output: ${out.stdout}`);
  return handle;
}

export async function poll(record) {
  const id = record.handle?.jobId;
  if (!id) throw new Error("lsf poll requires lsf handle");
  const live = await runCmd("bjobs", ["-noheader", id]);
  if (live.code === 0 && live.stdout.trim() && !/not found/i.test(live.stdout)) {
    const parsed = parseBjobsLine(live.stdout);
    if (parsed) return { status: parsed.status };
  }
  const hist = await runCmd("bhist", ["-l", id]);
  const parsed = parseBhistExit(hist.stdout + "\n" + hist.stderr);
  if (parsed) return parsed;
  return { status: "lost" };
}

export async function cancel(record) {
  const id = record.handle?.jobId;
  if (!id) throw new Error("no lsf job id");
  const res = await runCmd("bkill", [id]);
  if (res.code !== 0) throw new Error(res.stderr || "bkill failed");
}
