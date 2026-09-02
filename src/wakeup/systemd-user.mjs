import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../exec.mjs";

export const kind = "systemd-user";

function unitDir() {
  return join(homedir(), ".config", "systemd", "user");
}

export async function arm(record) {
  const dir = unitDir();
  await mkdir(dir, { recursive: true });
  const pathUnit = [
    `[Path]`,
    `PathExists=${record.terminal_path}`,
    `Unit=pi-runs-wake@${record.run_id}.service`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
  const svc = [
    `[Service]`,
    `Type=oneshot`,
    `ExecStart=${process.execPath} ${join(process.cwd(), "bin", "pi-runs-wake.mjs")} ${record.run_id}`,
    ``,
  ].join("\n");
  await writeFile(join(dir, `pi-runs-path@${record.run_id}.path`), pathUnit, "utf8");
  await writeFile(join(dir, `pi-runs-wake@${record.run_id}.service`), svc, "utf8");
  await runCmd("systemctl", ["--user", "daemon-reload"]);
  const start = await runCmd("systemctl", ["--user", "start", `pi-runs-path@${record.run_id}.path`]);
  if (start.code !== 0) {
    record.notes = [record.notes, `systemd-user arm failed: ${start.stderr}`].filter(Boolean).join("; ");
  }
}

export async function disarm(record) {
  await runCmd("systemctl", ["--user", "stop", `pi-runs-path@${record.run_id}.path`]);
}
