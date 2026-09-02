import net from "node:net";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function nativeTool(stem) {
  return process.platform === "win32" ? `${stem}.exe` : stem;
}

export function parseSshG(text) {
  const rows = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const split = line.search(/\s/);
    if (split < 0) continue;
    const key = line.slice(0, split).toLowerCase();
    const value = line.slice(split).trim();
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(value);
  }
  return rows;
}

function first(rows, key) {
  return rows.get(key)?.[0];
}

export function splitSshWords(value) {
  const words = [];
  let current = "";
  let quote = null;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\\" && quote !== "'" && next !== undefined) {
      // `ssh -G` on Windows emits native C:\\... paths. Preserve ordinary backslashes;
      // only consume a backslash as quoting when it actually escapes whitespace, a quote,
      // or another backslash.
      if (/\s/.test(next) || next === '"' || next === "'" || next === "\\") {
        current += next;
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function expandHome(value, env) {
  const home = env.USERPROFILE || env.HOME;
  if (!home) return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return value;
}

function configPath(path) {
  return String(path).replaceAll("\\", "/").replaceAll('"', '\\"');
}

export function renderIsolatedSshConfig({ alias, relayPort, user, knownHostsPath, identityFiles = [] }) {
  const lines = [
    `Host ${alias}`,
    "  HostName 127.0.0.1",
    `  Port ${relayPort}`,
    `  User ${user}`,
    "  IdentitiesOnly no",
    `  UserKnownHostsFile "${configPath(knownHostsPath)}"`,
    "  GlobalKnownHostsFile none",
    "  StrictHostKeyChecking yes",
  ];
  for (const identity of identityFiles) {
    lines.push(`  IdentityFile "${configPath(identity)}"`);
  }
  return `${lines.join("\n")}\n`;
}

export function resolveEffectiveSshHost(alias, env = process.env) {
  const output = spawnSync(nativeTool("ssh"), ["-G", alias], {
    env,
    windowsHide: true,
    encoding: "utf8",
  });
  if (output.status !== 0) {
    throw new Error(`ssh -G ${alias} failed: ${(output.stderr || output.stdout || "").trim()}`);
  }
  const rows = parseSshG(output.stdout);
  const hostname = first(rows, "hostname");
  const user = first(rows, "user");
  const port = Number(first(rows, "port") || 22);
  const proxyJump = first(rows, "proxyjump");
  if (!hostname || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ssh -G ${alias} did not return a usable hostname/user/port`);
  }
  if (proxyJump && proxyJump.toLowerCase() !== "none") {
    throw new Error(`SSH fault relay currently requires a direct host; ${alias} resolves ProxyJump=${proxyJump}`);
  }
  const knownHostsFiles = splitSshWords(first(rows, "userknownhostsfile"))
    .map((path) => expandHome(path, env))
    .filter((path) => path && path.toLowerCase() !== "none" && existsSync(path));
  const identityFiles = (rows.get("identityfile") || [])
    .flatMap(splitSshWords)
    .map((path) => expandHome(path, env))
    .filter((path) => path && existsSync(path));
  return { alias, hostname, user, port, knownHostsFiles, identityFiles };
}

export function trustedHostKeys(effective, env = process.env) {
  const lookup = effective.port === 22 ? effective.hostname : `[${effective.hostname}]:${effective.port}`;
  const keys = new Set();
  for (const path of effective.knownHostsFiles) {
    const output = spawnSync(nativeTool("ssh-keygen"), ["-F", lookup, "-f", path], {
      env,
      windowsHide: true,
      encoding: "utf8",
    });
    if (output.status !== 0 && output.status !== 1) {
      throw new Error(`ssh-keygen -F ${lookup} failed for ${path}: ${(output.stderr || "").trim()}`);
    }
    for (const raw of String(output.stdout || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const fields = line.split(/\s+/);
      if (fields.length >= 3 && fields[1].startsWith("ssh-")) {
        keys.add(`${fields[1]} ${fields[2]}`);
      }
    }
  }
  if (!keys.size) {
    throw new Error(`no pre-existing trusted known_hosts key found for ${lookup}; refusing to learn trust from the network`);
  }
  return [...keys];
}

export class TcpFaultRelay {
  constructor(targetHost, targetPort) {
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.enabled = true;
    this.pairs = new Set();
    this.server = net.createServer((client) => this.#accept(client));
  }

  #accept(client) {
    if (!this.enabled) {
      client.destroy();
      return;
    }
    const upstream = net.createConnection({ host: this.targetHost, port: this.targetPort });
    const pair = { client, upstream };
    this.pairs.add(pair);
    const dispose = () => this.pairs.delete(pair);
    const destroy = () => {
      client.destroy();
      upstream.destroy();
      dispose();
    };
    client.on("error", destroy);
    upstream.on("error", destroy);
    client.on("close", dispose);
    upstream.on("close", dispose);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  async listen() {
    await new Promise((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("fault relay did not bind a TCP port");
    this.port = address.port;
    return this.port;
  }

  cut() {
    this.enabled = false;
    for (const pair of [...this.pairs]) {
      pair.client.destroy();
      pair.upstream.destroy();
      this.pairs.delete(pair);
    }
  }

  restore() {
    this.enabled = true;
  }

  async close() {
    this.cut();
    if (!this.server.listening) return;
    await new Promise((resolvePromise) => this.server.close(resolvePromise));
  }
}

export async function prepareRunwatchSshFaultProfile({ alias, evidenceDir, env = process.env }) {
  const effective = resolveEffectiveSshHost(alias, env);
  const keys = trustedHostKeys(effective, env);
  const relay = new TcpFaultRelay(effective.hostname, effective.port);
  try {
    const relayPort = await relay.listen();
    const profileDir = resolve(evidenceDir, "runwatch-ssh-fault-profile");
    const sshDir = join(profileDir, ".ssh");
    await mkdir(sshDir, { recursive: true });
    const knownHostsPath = join(sshDir, "known_hosts");
    const knownHostLines = keys.map((key) => `[127.0.0.1]:${relayPort} ${key}`);
    await writeFile(knownHostsPath, `${knownHostLines.join("\n")}\n`, "utf8");
    const configPath = join(sshDir, "config");
    const config = renderIsolatedSshConfig({
      alias,
      relayPort,
      user: effective.user,
      knownHostsPath,
      identityFiles: effective.identityFiles,
    });
    await writeFile(configPath, config, "utf8");
    return {
      relay,
      profileDir,
      relayPort,
      effective,
      knownHostsPath,
      configPath,
    };
  } catch (error) {
    await relay.close();
    throw error;
  }
}
