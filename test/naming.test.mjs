import test from "node:test";
import assert from "node:assert/strict";
import {
  displayNameForRun,
  mnemonicDisplayName,
  resolveRunDisplayName,
  sanitizeDisplayName,
  semanticDisplayName,
} from "../src/naming.mjs";

test("explicit readable Run name is normalized and preserved", () => {
  const result = resolveRunDisplayName({
    requestedName: " Full Refinement ",
    command: "python secret.py --token top-secret",
    runId: "run-explicit-1",
  });
  assert.equal(result.name, "full-refinement");
  assert.equal(result.source, "requested");
});

test("missing name derives a short semantic script or task label without arguments", () => {
  assert.equal(semanticDisplayName("python scripts/refine_map.py --api-key VERYSECRET"), "refine-map");
  assert.equal(semanticDisplayName("npm run test:integration -- --token VERYSECRET"), "test-integration");
  assert.equal(semanticDisplayName("cargo test dangerous-secret-value"), "cargo-test");
});

test("unsafe or opaque naming input falls back to deterministic mnemonic", () => {
  const runId = "pi_01dd3b804bc8d542";
  const result = resolveRunDisplayName({
    requestedName: "https://example.invalid/token/SECRET",
    command: "bash -c 'curl https://example.invalid/?token=SECRET'",
    runId,
  });
  assert.equal(result.source, "mnemonic");
  assert.equal(result.name, mnemonicDisplayName(runId));
  assert.doesNotMatch(result.name, /secret|example|token/i);
});

test("automatic names never copy basename material from absolute command paths", () => {
  const unixRun = resolveRunDisplayName({
    command: "python /private/patient-alpha/refine_secret.py --token VERYSECRET",
    runId: "absolute-script-run",
  });
  assert.equal(unixRun.source, "mnemonic");
  assert.doesNotMatch(unixRun.name, /patient|refine|secret/i);

  const exeRun = resolveRunDisplayName({
    command: "/opt/private-analysis-tool --token VERYSECRET",
    runId: "absolute-executable-run",
  });
  assert.equal(exeRun.source, "mnemonic");
  assert.doesNotMatch(exeRun.name, /private|analysis|tool|secret/i);
});

test("automatic naming never scans interpreter option values or trailing arguments for a label", () => {
  const optionValue = resolveRunDisplayName({
    command: "python --config secret_payload.py public_script.py",
    runId: "interpreter-option-run",
  });
  assert.equal(optionValue.source, "mnemonic");
  assert.doesNotMatch(optionValue.name, /secret|payload|public|script/i);

  const trailing = resolveRunDisplayName({
    command: "python public_script.py VERYSECRET",
    runId: "interpreter-trailing-run",
  });
  assert.equal(trailing.name, "public-script");
  assert.doesNotMatch(trailing.name, /secret/i);
});

test("generated names are stable for the same Run identity", () => {
  const first = mnemonicDisplayName("stable-run-1");
  const second = mnemonicDisplayName("stable-run-1");
  assert.equal(first, second);
  assert.match(first, /^[a-z]+-[a-z]+$/);
});

test("duplicate readable names use a stable mnemonic suffix without renaming the existing Run", () => {
  const existing = [{ run_id: "old", name: "refine-map" }];
  const first = resolveRunDisplayName({
    command: "python refine_map.py",
    runId: "new-stable-id",
    existingRuns: existing,
  });
  const second = resolveRunDisplayName({
    command: "python refine_map.py",
    runId: "new-stable-id",
    existingRuns: existing,
  });
  assert.equal(first.name, second.name);
  assert.equal(first.collision, true);
  assert.match(first.name, /^refine-map-[a-z]+(?:-[a-z]+)?$/);
  assert.equal(existing[0].name, "refine-map");
});

test("ambiguous submit retry reuses the persisted name for the same Run identity", () => {
  const result = resolveRunDisplayName({
    requestedName: undefined,
    command: "python changed-looking-command.py",
    runId: "stable-retry-id",
    existingRuns: [{ run_id: "stable-retry-id", name: "original-refine", status: "running" }],
  });
  assert.equal(result.name, "original-refine");
  assert.equal(result.source, "existing");
  assert.equal(result.collision, false);
});

test("completed historical Runs do not force a suffix onto a new natural name", () => {
  const result = resolveRunDisplayName({
    command: "python refine_map.py",
    runId: "new-after-history",
    existingRuns: [{ run_id: "old-done", name: "refine-map", status: "succeeded" }],
  });
  assert.equal(result.name, "refine-map");
  assert.equal(result.collision, false);
});

test("legacy opaque Run names render as readable deterministic display names", () => {
  const run = { run_id: "r8b-public-execution", name: "r8b-public-execution" };
  const display = displayNameForRun(run);
  assert.notEqual(display, sanitizeDisplayName(run.name));
  assert.match(display, /^[a-z]+-[a-z]+$/);
});

test("unicode human names remain readable", () => {
  assert.equal(sanitizeDisplayName("完整 重构 测试"), "完整-重构-测试");
});
