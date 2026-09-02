export const kind = "webhook";

export async function arm() {}
export async function disarm() {}

export async function fire(record) {
  if (!record.webhook_url) return;
  const body = JSON.stringify({
    run_id: record.run_id,
    status: record.status,
    exit_code: record.exit_code ?? null,
    handle: record.handle ?? null,
  });
  const res = await fetch(record.webhook_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error(`webhook ${res.status}`);
  }
}
