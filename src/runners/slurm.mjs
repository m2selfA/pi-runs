import { writeFile } from "node:fs/promises";
import { runCmd } from "../exec.mjs";
import { parseSbatchOutput, parseSacctLine, parseSqueueLine, mapSlurmState } from "../parse.mjs";
import { renderSlurmScript, scriptPath } from "../templates.mjs";

export async function submit(record, req) {
  const path = scriptPath(record);
  await writeFile(path, renderSlurmScript(record, req), { encoding: "utf8", mode: 0o755 });
  const res = await runCmd("sbatch", [path], { cwd: record.workdir });
  if (res.code !== 0) {
    throw new Error(`sbatch failed: ${res.stderr || res.stdout}`);
  }
  const handle = parseSbatchOutput(res.stdout + "\n" + res.stderr);
  if (!handle) throw new Error(`could not parse sbatch output: ${res.stdout}`);
  return handle;
}

export async function poll(record) {
  if (!record.handle || record.handle.kind !== "slurm") {
    throw new Error("slurm poll requires slurm handle");
  }
  const id = record.handle.jobId;
  const live = await runCmd("squeue", ["-h", "-j", id, "-o", "%i %T"]);
  if (live.code === 0 && live.stdout.trim()) {
    const parsed = parseSqueueLine(live.stdout);
    if (parsed) return { status: parsed.status };
  }
  const hist = await runCmd("sacct", ["-j", id, "-n", "-P", "-o", "JobID,State,ExitCode"]);
  const parsed = parseSacctLine(hist.stdout);
  if (parsed) return { status: parsed.status, exit_code: parsed.exit_code };
  return { status: "lost" };
}

export async function cancel(record) {
  const id = record.handle?.jobId;
  if (!id) throw new Error("no slurm job id");
  const res = await runCmd("scancel", [id]);
  if (res.code !== 0) throw new Error(res.stderr || "scancel failed");
}

export function mapState(s) {
  return mapSlurmState(s);
}
