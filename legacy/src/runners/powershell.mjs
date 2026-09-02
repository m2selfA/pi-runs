import { writeFile } from "node:fs/promises";
import { runCmd } from "../exec.mjs";
import { parsePowershellJobId, mapPowershellState } from "../parse.mjs";
import { renderPowershellScript, scriptPath } from "../templates.mjs";

async function pwsh() {
  const probe = await runCmd("pwsh", ["-NoLogo", "-Command", "$PSVersionTable.PSVersion"]);
  if (probe.code === 0) return "pwsh";
  return "powershell";
}

export async function submit(record, req) {
  const path = scriptPath(record);
  await writeFile(path, renderPowershellScript(record, req), "utf8");
  const shell = await pwsh();
  const cmd = [
    `-NoLogo`,
    `-NoProfile`,
    `-Command`,
    `$job = Start-Job -Name '${record.run_id}' -FilePath '${path.replace(/'/g, "''")}'; $job.Id; $job.InstanceId.Guid`,
  ];
  const res = await runCmd(shell, cmd, { cwd: record.workdir });
  if (res.code !== 0) throw new Error(`Start-Job failed: ${res.stderr || res.stdout}`);
  const handle = parsePowershellJobId(res.stdout);
  if (!handle) throw new Error(`could not parse PowerShell job id: ${res.stdout}`);
  return handle;
}

export async function poll(record) {
  const id = record.handle?.instanceId;
  if (!id) throw new Error("powershell poll requires instanceId");
  const shell = await pwsh();
  const res = await runCmd(shell, [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    `Get-Job | Where-Object { $_.Id -eq '${id}' -or $_.InstanceId.Guid -eq '${id}' -or $_.Name -eq '${record.run_id}' } | Select-Object -First 1 -ExpandProperty State`,
  ]);
  if (res.code !== 0 || !res.stdout.trim()) return { status: "lost" };
  const status = mapPowershellState(res.stdout.trim());
  return { status: status || "running" };
}

export async function cancel(record) {
  const id = record.handle?.instanceId;
  const shell = await pwsh();
  const res = await runCmd(shell, [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    `Get-Job | Where-Object { $_.Id -eq '${id}' -or $_.InstanceId.Guid -eq '${id}' -or $_.Name -eq '${record.run_id}' } | Stop-Job -PassThru | Remove-Job -Force`,
  ]);
  if (res.code !== 0) throw new Error(res.stderr || "Stop-Job failed");
}
