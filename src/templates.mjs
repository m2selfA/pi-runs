import { join } from "node:path";

export function sidecarSnippet(record, shell) {
  const term = record.terminal_path.replace(/\\/g, "/");
  if (shell === "ps1") {
    return [
      `try {`,
      `  # USER_COMMAND`,
      `  "succeeded 0" | Set-Content -Encoding utf8 "${record.terminal_path}"`,
      `} catch {`,
      `  "failed 1" | Set-Content -Encoding utf8 "${record.terminal_path}"`,
      `  throw`,
      `}`,
    ].join("\n");
  }
  return [
    `term_file="${term}"`,
    `mark() { printf '%s %s\n' "$1" "$2" > "$term_file"; }`,
    `trap 'mark failed $?' ERR`,
    `# USER_COMMAND`,
    `mark succeeded 0`,
  ].join("\n");
}

export function renderSlurmScript(record, req) {
  const headers = [
    "#!/bin/bash",
    `#SBATCH --job-name=${req.name || record.run_id}`,
    `#SBATCH --output=${record.stdout_path}`,
    `#SBATCH --error=${record.stderr_path}`,
  ];
  if (req.partition) headers.push(`#SBATCH --partition=${req.partition}`);
  if (req.account) headers.push(`#SBATCH --account=${req.account}`);
  if (req.time) headers.push(`#SBATCH --time=${req.time}`);
  if (req.cpus) headers.push(`#SBATCH --cpus-per-task=${req.cpus}`);
  if (req.mem) headers.push(`#SBATCH --mem=${req.mem}`);
  if (req.gpus) headers.push(`#SBATCH --gres=gpu:${req.gpus}`);
  if (req.extra_headers) headers.push(...req.extra_headers);
  return `${headers.join("\n")}\nset -euo pipefail\ncd "${record.workdir}"\n${sidecarSnippet(record, "bash").replace("# USER_COMMAND", req.command)}\n`;
}

export function renderLsfScript(record, req) {
  const headers = [
    "#!/bin/bash",
    `#BSUB -J ${req.name || record.run_id}`,
    `#BSUB -oo ${record.stdout_path}`,
    `#BSUB -eo ${record.stderr_path}`,
  ];
  if (req.queue) headers.push(`#BSUB -q ${req.queue}`);
  if (req.account) headers.push(`#BSUB -P ${req.account}`);
  if (req.time) headers.push(`#BSUB -W ${req.time}`);
  if (req.cpus) headers.push(`#BSUB -n ${req.cpus}`);
  if (req.mem) headers.push(`#BSUB -M ${req.mem}`);
  if (req.gpus) headers.push(`#BSUB -gpu "num=${req.gpus}"`);
  if (req.extra_headers) headers.push(...req.extra_headers);
  return `${headers.join("\n")}\nset -euo pipefail\ncd "${record.workdir}"\n${sidecarSnippet(record, "bash").replace("# USER_COMMAND", req.command)}\n`;
}

export function renderPowershellScript(record, req) {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Set-Location -LiteralPath '${record.workdir.replace(/'/g, "''")}'`,
    `try {`,
    `  ${req.command}`,
    `  'succeeded 0' | Set-Content -Encoding utf8 -LiteralPath '${record.terminal_path.replace(/'/g, "''")}'`,
    `} catch {`,
    `  'failed 1' | Set-Content -Encoding utf8 -LiteralPath '${record.terminal_path.replace(/'/g, "''")}'`,
    `  throw`,
    `}`,
  ].join("\n");
}

export function scriptPath(record) {
  const ext = record.runner === "powershell" ? "ps1" : "sh";
  return join(record.run_dir, `job.${ext}`);
}
