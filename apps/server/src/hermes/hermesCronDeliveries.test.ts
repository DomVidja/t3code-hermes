// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { HERMES_CRON_OUTPUT_LENGTH, HERMES_CRON_PREVIEW_LENGTH } from "@t3tools/contracts";

import {
  boundHermesOutput,
  createHermesCronDeliveryReader,
  hermesOutputToPlainText,
} from "./hermesCronDeliveries.ts";
import {
  appendHermesDeliveryFixture,
  createHermesDeliveryFixture,
  FIXTURE_JOB_ID,
} from "./hermesCronDeliveryFixtures.ts";
import {
  parseHermesCronJobs,
  readHermesCronRuns,
  resolveHermesCronPaths,
} from "./hermesCronState.ts";

let directory: string;
let home: string;
beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cron-output-"));
  home = NodePath.join(directory, "hermes");
  createHermesDeliveryFixture(home);
});
afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

function execute(file: string, sql: string) {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, file));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
function read(reader = createHermesCronDeliveryReader(), full = false) {
  const paths = resolveHermesCronPaths({ HERMES_HOME: home });
  const jobs = parseHermesCronJobs(JSON.parse(NodeFS.readFileSync(paths.jobsFile, "utf8")))!;
  const runs = readHermesCronRuns(paths.executionsDb, [FIXTURE_JOB_ID])!;
  return reader.read(paths, jobs, runs, full);
}

describe("Hermes plaintext previews", () => {
  it("strips Markdown formatting while preserving readable text", () => {
    expect(
      hermesOutputToPlainText(
        [
          "## Morning engineering digest",
          "",
          "- **Builds:** all checks passed on `main`.",
          "- **Review:** [two pull requests](https://example.com/reviews) are _ready_.",
          "1. *Next:* review the __release__.",
          "- [x] ~~Old incident~~ resolved.",
        ].join("\n"),
      ),
    ).toBe(
      "Morning engineering digest Builds: all checks passed on main. Review: two pull requests are ready. Next: review the release. Old incident resolved.",
    );
    expect(hermesOutputToPlainText("**A** and *B* and _C_.")).toBe("A and B and C.");
    // Unclosed or cross-line markers stay literal instead of scanning the whole preview.
    expect(hermesOutputToPlainText("*a ".repeat(3) + "[x](y <z")).toBe("*a *a *a [x](y <z");
    expect(hermesOutputToPlainText("**not\nbold**")).toBe("**not bold**");
    expect(hermesOutputToPlainText("Keep snake_case, 2 * 3, and file_name.ts.")).toBe(
      "Keep snake_case, 2 * 3, and file_name.ts.",
    );
  });
});

describe("Hermes 0.21.0 delivery/session output", () => {
  it("uses durable cron assistant text after terminal delivery payloads are erased", () => {
    const id = appendHermesDeliveryFixture(home, { content: "## Digest\n\nEverything passed." });
    expect(read().runs[0]?.delivery).toMatchObject({
      preview: "Digest Everything passed.",
      source: "session",
      status: "delivered",
      contentAvailable: true,
    });
    expect(read(undefined, true).outputs.get(id)?.content).toBe("## Digest\n\nEverything passed.");
  });

  it.each(["delivered", "pending"] as const)(
    "cleans %s previews before bounding them and preserves full Markdown",
    (deliveryStatus) => {
      const content = `## Digest\n\n${"- **Builds:** passed on `main`.\n".repeat(100)}`;
      const id = appendHermesDeliveryFixture(home, { content, deliveryStatus });
      const expected = hermesOutputToPlainText(content).slice(0, HERMES_CRON_PREVIEW_LENGTH);
      const preview = read().runs[0]?.delivery;
      expect(preview).toMatchObject({ preview: expected, truncated: true });
      expect(preview?.preview).toHaveLength(HERMES_CRON_PREVIEW_LENGTH);
      const full = read(undefined, true);
      expect(full.outputs.get(id)?.content).toBe(content);
      expect(full.runs[0]?.delivery.preview).toBe(expected);
    },
  );

  it("reads agent output without a gateway queue and does not claim it was delivered", () => {
    appendHermesDeliveryFixture(home, { deliveryStatus: "none" });
    expect(read().runs[0]?.delivery).toMatchObject({
      source: "session",
      status: "unrecorded",
      contentAvailable: true,
    });
  });

  it("retains observed queue content and targets through Hermes's immediate terminal redaction", () => {
    const id = appendHermesDeliveryFixture(home, {
      status: "failed",
      deliveryStatus: "pending",
      content: "Action required: credentials expired.",
    });
    const reader = createHermesCronDeliveryReader();
    expect(read(reader).runs[0]?.delivery).toMatchObject({
      source: "delivery",
      status: "pending",
      targets: ["origin (telegram)"],
    });
    execute(
      "cron/deliveries.db",
      "UPDATE deliveries SET status='failed', content='', job_json='{}', error='Gateway unreachable'",
    );
    expect(read(reader, true).outputs.get(id)?.content).toBe(
      "Action required: credentials expired.",
    );
    expect(read(reader).runs[0]?.delivery).toMatchObject({
      status: "failed",
      error: "Gateway unreachable",
      targets: ["origin (telegram)"],
    });
    expect(read().runs[0]?.delivery.contentAvailable).toBe(false);
  });

  it("uses a queue failure target override and rejects malformed job JSON safely", () => {
    appendHermesDeliveryFixture(home, { deliveryStatus: "pending" });
    execute(
      "cron/deliveries.db",
      `UPDATE deliveries SET for_failure=1, job_json='{"deliver":"telegram","failure_deliver":"discord"}'`,
    );
    expect(read().runs[0]?.delivery.targets).toEqual(["discord"]);
    // A long job prompt must not truncate the recorded recipient away.
    const longJob = JSON.stringify({ prompt: "x".repeat(70_000), deliver: ["slack"] });
    execute("cron/deliveries.db", `UPDATE deliveries SET for_failure=0, job_json='${longJob}'`);
    expect(read().runs[0]?.delivery.targets).toEqual(["slack"]);
    execute("cron/deliveries.db", "UPDATE deliveries SET job_json='{' ");
    expect(read().runs[0]?.delivery.contentAvailable).toBe(true);
  });

  it("preserves tombstoned outcomes without inventing payloads", () => {
    appendHermesDeliveryFixture(home, { id: "tombstone" });
    execute(
      "cron/deliveries.db",
      "DELETE FROM deliveries; INSERT INTO delivery_tombstones VALUES ('tombstone', 'unknown', NULL)",
    );
    expect(read().runs[0]?.delivery).toMatchObject({ status: "unknown", source: "session" });
  });

  it("bounds previews and on-demand output separately, without breaking Unicode", () => {
    const content = "x".repeat(HERMES_CRON_OUTPUT_LENGTH + 100);
    const id = appendHermesDeliveryFixture(home, { content });
    expect(read().runs[0]?.delivery.preview).toHaveLength(HERMES_CRON_PREVIEW_LENGTH);
    expect(read().runs[0]?.delivery.truncated).toBe(true);
    expect(read(undefined, true).outputs.get(id)).toMatchObject({
      content: content.slice(0, HERMES_CRON_OUTPUT_LENGTH),
      truncated: true,
    });
    expect(boundHermesOutput("abc😀z", 4)).toBe("abc");
    expect(boundHermesOutput("abc😀z", 5)).toBe("abc😀");
  });

  it("follows compression continuations, excluding delegate sessions", () => {
    appendHermesDeliveryFixture(home);
    execute(
      "state.db",
      `
      INSERT INTO sessions (id, source, parent_session_id, started_at, end_reason)
        SELECT 'continuation', 'cron', id, started_at + 2, 'cron_complete' FROM sessions;
      INSERT INTO sessions (id, source, parent_session_id, started_at, end_reason, model_config)
        SELECT 'delegate', 'tool', id, started_at + 2, 'cron_complete', '{"_delegate_from":"root"}' FROM sessions WHERE parent_session_id IS NULL;
      UPDATE sessions SET end_reason='compression' WHERE parent_session_id IS NULL;
      INSERT INTO messages (session_id, role, content, timestamp)
        SELECT 'continuation', 'assistant', 'Final compressed report', timestamp + 0.5 FROM messages LIMIT 1;
    `,
    );
    expect(read().runs[0]?.delivery.preview).toBe("Final compressed report");
  });

  it("never substitutes a partial assistant turn or another run's report", () => {
    appendHermesDeliveryFixture(home);
    execute(
      "state.db",
      "INSERT INTO messages (session_id, role, content, timestamp) SELECT session_id, 'tool', 'tool result', timestamp + 1 FROM messages",
    );
    expect(read().runs[0]?.delivery.contentAvailable).toBe(false);
    execute(
      "state.db",
      "DELETE FROM messages WHERE role='tool'; UPDATE sessions SET started_at=started_at-600",
    );
    expect(read().runs[0]?.delivery.contentAvailable).toBe(false);
  });

  it("fails closed for ambiguous cron roots", () => {
    appendHermesDeliveryFixture(home);
    execute(
      "state.db",
      `INSERT INTO sessions (id, source, started_at, end_reason) SELECT 'cron_t3-digest_20200101_000000', source, started_at, end_reason FROM sessions`,
    );
    expect(read().runs[0]?.delivery.contentAvailable).toBe(false);
  });

  it("does not assign one session to two overlapping attempts", () => {
    appendHermesDeliveryFixture(home, { id: "real-report" });
    execute(
      "cron/executions.db",
      `INSERT INTO executions
      SELECT 'overlapping', job_id, source, process_id, pid, process_started_at,
        status, claimed_at, started_at, finished_at, error FROM executions`,
    );
    const result = read();
    expect(result.runs).toHaveLength(2);
    expect(result.runs.every((run) => !run.delivery.contentAvailable)).toBe(true);
  });

  it("fails closed when a sibling attempt has an unparseable timestamp", () => {
    appendHermesDeliveryFixture(home, { id: "real-report" });
    execute(
      "cron/executions.db",
      `INSERT INTO executions
      SELECT 'malformed', job_id, source, process_id, pid, process_started_at,
        status, 'not-a-time', 'not-a-time', 'not-a-time', error FROM executions`,
    );
    const report = read().runs.find((run) => run.id === "real-report");
    expect(report?.delivery.contentAvailable).toBe(false);
  });

  it("does not leak a cached output into another Hermes home", () => {
    appendHermesDeliveryFixture(home, {
      id: "same-id",
      status: "failed",
      deliveryStatus: "pending",
    });
    const reader = createHermesCronDeliveryReader();
    expect(read(reader).runs[0]?.delivery.contentAvailable).toBe(true);
    home = NodePath.join(directory, "other-hermes");
    createHermesDeliveryFixture(home);
    appendHermesDeliveryFixture(home, { id: "same-id", status: "failed" });
    expect(read(reader).runs[0]?.delivery.contentAvailable).toBe(false);
  });

  it("degrades gracefully for absent/corrupt stores without creating files", () => {
    appendHermesDeliveryFixture(home);
    NodeFS.rmSync(NodePath.join(home, "state.db"));
    NodeFS.writeFileSync(NodePath.join(home, "cron/deliveries.db"), "corrupt");
    expect(read().runs[0]?.delivery).toMatchObject({
      contentAvailable: false,
      status: "unrecorded",
    });
    expect(NodeFS.existsSync(NodePath.join(home, "state.db"))).toBe(false);
  });

  it("pins queue status constraints and never overwrites an existing home", () => {
    expect(() =>
      execute(
        "cron/deliveries.db",
        "INSERT INTO deliveries VALUES ('x','{}','content',0,'new-status',NULL,NULL,NULL,'now',NULL,NULL)",
      ),
    ).toThrow();
    expect(() => createHermesDeliveryFixture(home)).toThrow();
  });
});
