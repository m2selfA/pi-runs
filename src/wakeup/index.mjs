import * as poll from "./poll.mjs";
import * as sidecar from "./sidecar.mjs";
import * as systemdUser from "./systemd-user.mjs";
import * as powershellEvent from "./powershell-event.mjs";
import * as webhook from "./webhook.mjs";

const table = {
  poll,
  sidecar,
  "systemd-user": systemdUser,
  "powershell-event": powershellEvent,
  webhook,
};

export function wakeupFor(kind) {
  return table[kind] || poll;
}

export { sidecar };
