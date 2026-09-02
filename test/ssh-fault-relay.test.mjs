import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { TcpFaultRelay, parseSshG, renderIsolatedSshConfig, splitSshWords } from "../scripts/acceptance/ssh_fault_relay.mjs";

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(resolvePromise));
}

function roundTrip(port, payload) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("relay round trip timed out"));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.once("data", (text) => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(text);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      if (!socket.readableEnded && !socket.destroyed) return;
    });
  });
}

test("ssh -G parser preserves repeated values and isolated config pins localhost trust", () => {
  const rows = parseSshG([
    "hostname 192.0.2.10",
    "user scientist",
    "port 22",
    "identityfile ~/.ssh/id_ed25519",
    "identityfile C:/keys/other",
  ].join("\n"));
  assert.deepEqual(rows.get("identityfile"), ["~/.ssh/id_ed25519", "C:/keys/other"]);
  assert.equal(rows.get("hostname")[0], "192.0.2.10");
  assert.deepEqual(
    splitSshWords('C:\\Users\\test-user/.ssh/known_hosts "C:\\Users\\Some User\\known_hosts"'),
    ["C:\\Users\\test-user/.ssh/known_hosts", "C:\\Users\\Some User\\known_hosts"],
  );

  const config = renderIsolatedSshConfig({
    alias: "cluster",
    relayPort: 43123,
    user: "scientist",
    knownHostsPath: "C:\\evidence\\known_hosts",
    identityFiles: ["C:\\Users\\me\\.ssh\\id_ed25519"],
  });
  assert.match(config, /^Host cluster/m);
  assert.match(config, /HostName 127\.0\.0\.1/);
  assert.match(config, /Port 43123/);
  assert.match(config, /StrictHostKeyChecking yes/);
  assert.match(config, /UserKnownHostsFile "C:\/evidence\/known_hosts"/);
  assert.match(config, /IdentityFile "C:\/Users\/me\/\.ssh\/id_ed25519"/);
});

test("fault relay cuts active TCP transport and accepts fresh connections after restore", async () => {
  const target = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolvePromise, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = target.address();
  assert.ok(address && typeof address !== "string");
  const relay = new TcpFaultRelay("127.0.0.1", address.port);
  const relayPort = await relay.listen();
  try {
    assert.equal(await roundTrip(relayPort, "before"), "before");
    relay.cut();
    await assert.rejects(roundTrip(relayPort, "during"));
    relay.restore();
    assert.equal(await roundTrip(relayPort, "after"), "after");
  } finally {
    await relay.close();
    await closeServer(target);
  }
});
