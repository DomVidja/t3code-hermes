import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateHermesRun from "./055_ProjectionThreadsHermesRun.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "055_ProjectionThreadsHermesRun",
  (it) => {
    it.effect("adds the column with existing threads left as ordinary threads", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        const now = "2026-09-30T00:00:00.000Z";
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;
        yield* runMigrations({ toMigrationInclusive: 55 });
        const migrated = yield* sql<{ readonly hermesRun: string | null }>`
        SELECT hermes_run_json AS "hermesRun" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(migrated, [{ hermesRun: null }]);
        // Re-running against a database that already has the column keeps its value.
        yield* sql`UPDATE projection_threads SET hermes_run_json = '{}' WHERE thread_id = 'thread-1'`;
        yield* migrateHermesRun;
        const rows = yield* sql<{ readonly hermesRun: string | null }>`
        SELECT hermes_run_json AS "hermesRun" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(rows, [{ hermesRun: "{}" }]);
      }),
    );
  },
);
