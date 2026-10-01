import { assert, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";

import { HermesBackgroundProcesses, type HermesProcessReport } from "./HermesBackground.ts";

const running: HermesProcessReport = {
  sessionId: "acp-1",
  toolCallId: "tc-1",
  processId: "proc_1",
  command: "npm run dev",
  status: "running",
};
const turnId = TurnId.make("turn-1");

it("settles each exit reason as the matching task status", () => {
  const cases: Array<[Partial<HermesProcessReport>, string, string | undefined]> = [
    [{ exitCode: 0, reason: "exited" }, "completed", undefined],
    [{ exitCode: 2, reason: "exited" }, "failed", "Exit code 2"],
    [{ exitCode: -15, reason: "killed" }, "stopped", "Stopped"],
    [{ exitCode: null, reason: "lost" }, "failed", "Process backend disappeared"],
  ];
  for (const [exit, status, summary] of cases) {
    const processes = new HermesBackgroundProcesses();
    processes.report(running, turnId);
    const [event] = processes.report({ ...running, status: "exited", ...exit }, undefined);
    assert.equal(event?.type, "task.completed");
    assert.equal(event?.turnId, turnId);
    assert.deepInclude(event?.payload ?? {}, { status, ...(summary ? { summary } : {}) });
  }
});

it("ignores repeated starts and exits it never saw start", () => {
  const processes = new HermesBackgroundProcesses();
  assert.lengthOf(processes.report({ ...running, status: "exited", exitCode: 0 }, turnId), 0);
  assert.lengthOf(processes.report(running, turnId), 1);
  assert.lengthOf(processes.report(running, turnId), 0);
});

it("stops every live process when the Hermes session ends", () => {
  const processes = new HermesBackgroundProcesses();
  processes.report(running, turnId);
  processes.report({ ...running, processId: "proc_2", toolCallId: "tc-2" }, undefined);
  const stopped = processes.stopAll();
  assert.deepEqual(
    stopped.map((event) => [
      event.payload.taskId,
      event.type === "task.completed" ? event.payload.status : event.type,
    ]),
    [
      ["proc_1", "stopped"],
      ["proc_2", "stopped"],
    ],
  );
  assert.lengthOf(processes.stopAll(), 0);
});
