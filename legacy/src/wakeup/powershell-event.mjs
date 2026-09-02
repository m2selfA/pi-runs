import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCmd } from "../exec.mjs";

export const kind = "powershell-event";

export async function arm(record) {
  const watcher = join(record.run_dir, "watch.ps1");
  const body = [
    `$term = '${record.terminal_path.replace(/'/g, "''")}'`,
    `$runId = '${record.run_id}'`,
    `$wake = Join-Path $PSScriptRoot '..\\..\\bin\\pi-runs-wake.mjs'`,
    `if (-not (Test-Path $wake)) { $wake = 'pi-runs-wake' }`,
    `$job = Get-Job | Where-Object { $_.Name -eq $runId } | Select-Object -First 1`,
    `if ($job) {`,
    `  Register-ObjectEvent -InputObject $job -EventName StateChanged -SourceIdentifier "pi-runs-$runId" -Action {`,
    `    $s = $Event.Sender.State.ToString()`,
    `    if ($s -in @('Completed','Failed','Stopped')) {`,
    `      if (-not (Test-Path $term)) { "$s".ToLower() | Out-File $term }`,
    `    }`,
    `  } | Out-Null`,
    `}`,
    `# file watcher fallback`,
    `$dir = Split-Path $term`,
    `$fsw = New-Object IO.FileSystemWatcher $dir, (Split-Path $term -Leaf)`,
    `$fsw.EnableRaisingEvents = $true`,
    ``,
  ].join("\n");
  await writeFile(watcher, body, "utf8");
  const shellProbe = await runCmd("pwsh", ["-NoLogo", "-Command", "1"]);
  const shell = shellProbe.code === 0 ? "pwsh" : "powershell";
  await runCmd(shell, ["-NoLogo", "-NoProfile", "-File", watcher]);
}

export async function disarm(record) {
  const shellProbe = await runCmd("pwsh", ["-NoLogo", "-Command", "1"]);
  const shell = shellProbe.code === 0 ? "pwsh" : "powershell";
  await runCmd(shell, [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    `Unregister-Event -SourceIdentifier 'pi-runs-${record.run_id}' -ErrorAction SilentlyContinue`,
  ]);
}
