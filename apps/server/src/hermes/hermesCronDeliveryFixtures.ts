// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off
/** Synthetic Hermes 0.21.0 state for tests and local notification demonstrations. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  HERMES_CRON_SESSIONS_DDL,
  HERMES_DELIVERIES_DDL,
  HERMES_EXECUTIONS_DDL,
  makeHermesJobRecord,
  makeHermesJobsFile,
} from "./hermesCronFixtures.ts";

const MARKER = ".t3-synthetic-cron-fixture";
export const FIXTURE_JOB_ID = "t3-digest";

/** Refuses existing directories, so this can never initialize a real Hermes home. */
export function createHermesDeliveryFixture(home: string): void {
  NodeFS.mkdirSync(home);
  NodeFS.writeFileSync(NodePath.join(home, MARKER), "Hermes delivery tests only\n");
  NodeFS.mkdirSync(NodePath.join(home, "cron"));
  NodeFS.writeFileSync(
    NodePath.join(home, "cron/jobs.json"),
    makeHermesJobsFile([
      makeHermesJobRecord({
        id: FIXTURE_JOB_ID,
        name: "Morning engineering digest",
        deliver: "origin",
        origin: { platform: "telegram", chat_id: "fixture-chat" },
      }),
    ]),
  );
  for (const [file, ddl] of [
    ["cron/executions.db", HERMES_EXECUTIONS_DDL],
    ["cron/deliveries.db", HERMES_DELIVERIES_DDL],
    ["state.db", HERMES_CRON_SESSIONS_DDL],
  ] as const) {
    const database = new NodeSqlite.DatabaseSync(NodePath.join(home, file));
    try {
      database.exec(ddl);
    } finally {
      database.close();
    }
  }
}

/** Append while T3 is subscribed; its next 60-second poll observes the new completion. */
export function appendHermesDeliveryFixture(
  home: string,
  options: {
    readonly id?: string;
    readonly content?: string;
    readonly status?: "running" | "completed" | "failed";
    readonly deliveryStatus?:
      | "pending"
      | "delivering"
      | "delivered"
      | "failed"
      | "unknown"
      | "none";
    readonly startedAt?: string;
  } = {},
): string {
  if (!NodeFS.existsSync(NodePath.join(home, MARKER)))
    throw new Error("Not a synthetic cron fixture");
  const id = options.id ?? `exec-${crypto.randomUUID()}`;
  const history = new NodeSqlite.DatabaseSync(NodePath.join(home, "cron/executions.db"), {
    readOnly: true,
  });
  let latestFinished = 0;
  try {
    const latest = history.prepare("SELECT MAX(finished_at) AS finished_at FROM executions").get();
    if (typeof latest?.finished_at === "string") latestFinished = Date.parse(latest.finished_at);
  } finally {
    history.close();
  }
  // Disjoint intervals let repeated demonstrations run immediately, without sleeps or
  // accidentally assigning the same second-resolution cron session to two attempts.
  const started = new Date(
    options.startedAt ?? Math.max(Date.now() - 30_000, latestFinished + 1_000),
  );
  const finished = new Date(started.getTime() + 30_000);
  const status = options.status ?? "completed";
  const deliveryStatus = options.deliveryStatus ?? "delivered";
  const content =
    options.content ??
    "## Morning engineering digest\n\n- **Builds:** all checks passed.\n- **Review:** two pull requests are ready.\n\nNo incidents need attention today.";
  const sessionId = `cron_${FIXTURE_JOB_ID}_${started.toISOString().slice(0, 10).replaceAll("-", "")}_${started.toISOString().slice(11, 19).replaceAll(":", "")}`;
  const jobs = JSON.parse(NodeFS.readFileSync(NodePath.join(home, "cron/jobs.json"), "utf8")) as {
    jobs: Record<string, unknown>[];
  };
  const job = jobs.jobs[0]!;
  job.last_run_at = finished.toISOString();
  job.last_status = status === "failed" ? "error" : "ok";
  const state = new NodeSqlite.DatabaseSync(NodePath.join(home, "state.db"));
  try {
    state
      .prepare(
        "INSERT INTO sessions (id, source, started_at, ended_at, end_reason) VALUES (?, 'cron', ?, ?, ?)",
      )
      .run(
        sessionId,
        started.getTime() / 1000 + 1,
        finished.getTime() / 1000 - 1,
        status === "completed" ? "cron_complete" : "cron_incomplete_no_output",
      );
    state
      .prepare(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', ?, ?)",
      )
      .run(sessionId, content, finished.getTime() / 1000 - 2);
  } finally {
    state.close();
  }
  const deliveries = new NodeSqlite.DatabaseSync(NodePath.join(home, "cron/deliveries.db"));
  try {
    if (deliveryStatus !== "none") {
      // Hermes clears content AND job_json in the same transaction that terminalizes delivery.
      const terminal = ["delivered", "failed", "unknown"].includes(deliveryStatus);
      deliveries
        .prepare(
          "INSERT INTO deliveries (execution_id, job_json, content, status, created_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          terminal ? "{}" : JSON.stringify(job),
          terminal ? "" : content,
          deliveryStatus,
          started.toISOString(),
          terminal ? finished.toISOString() : null,
          deliveryStatus === "failed" ? "Gateway unreachable" : null,
        );
    }
  } finally {
    deliveries.close();
  }
  const executions = new NodeSqlite.DatabaseSync(NodePath.join(home, "cron/executions.db"));
  try {
    executions
      .prepare(
        "INSERT INTO executions (id, job_id, source, process_id, pid, status, claimed_at, started_at, finished_at, error) VALUES (?, ?, 'builtin', 'fixture', 4242, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        FIXTURE_JOB_ID,
        status,
        started.toISOString(),
        started.toISOString(),
        status === "running" ? null : finished.toISOString(),
        status === "failed" ? "Provider timeout" : null,
      );
  } finally {
    executions.close();
  }
  NodeFS.writeFileSync(NodePath.join(home, "cron/jobs.json"), JSON.stringify(jobs));
  return id;
}
