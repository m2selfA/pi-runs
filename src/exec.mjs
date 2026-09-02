import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runCmd(file, args, opts = {}) {
  const { timeout = 30_000, cwd, env } = opts;
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout,
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      maxBuffer: 2_000_000,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: String(err.stdout || ""),
      stderr: String(err.stderr || err.message || ""),
    };
  }
}
