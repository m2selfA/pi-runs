import { readFile } from "node:fs/promises";
import { parseTerminalFile } from "../parse.mjs";

export const kind = "sidecar";

export async function arm() {
  /* scripts already write the terminal file */
}

export async function disarm() {}

export async function readSidecar(record) {
  try {
    const text = await readFile(record.terminal_path, "utf8");
    return parseTerminalFile(text);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}
