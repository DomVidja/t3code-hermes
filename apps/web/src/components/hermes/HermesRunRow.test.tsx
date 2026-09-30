// @vitest-environment jsdom
import {
  EnvironmentId,
  HermesCronJobId,
  type HermesCronJob,
  type HermesCronRun,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ getOutput: vi.fn(), jobs: [] as HermesCronJob[] }));
vi.mock("../../state/server", () => ({ serverEnvironment: { hermesCronGetRunOutput: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.getOutput }));
vi.mock("../../state/hermesCron", () => ({
  useHermesCron: (environmentId: EnvironmentId) => ({
    environmentId,
    jobs: state.jobs,
    isPending: false,
    error: null,
    emptyState: null,
    view: { snapshot: { runHistoryAvailable: true } },
    setEnabled: vi.fn(),
    setMuted: vi.fn(),
  }),
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

import { HermesRunRow } from "./HermesRunRow";
import { HermesTasksTab } from "./HermesTasksTab";

const environmentId = EnvironmentId.make("remote");
const run: HermesCronRun = {
  id: "run",
  jobId: HermesCronJobId.make("job"),
  status: "completed",
  source: null,
  claimedAt: null,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  error: null,
  delivery: {
    preview: "Short preview",
    contentAvailable: true,
    truncated: true,
    source: "session",
    targets: ["local"],
    status: "unrecorded",
    error: null,
  },
};
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.getOutput.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { content: "Full report", truncated: false, source: "session" },
  });
  state.jobs = [
    {
      id: run.jobId,
      name: "Report",
      scheduleDisplay: "daily",
      state: "scheduled",
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      deliver: ["local"],
      muted: false,
      runs: [run],
    },
  ];
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("fetches full output only when a run is expanded, not when task history opens", async () => {
  await act(async () => {
    renderer = create(<HermesTasksTab onNewTask={vi.fn()} target={{ environmentId }} />);
  });
  expect(state.getOutput).not.toHaveBeenCalled();
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Expand task Report" }).props.onClick(),
  );
  expect(state.getOutput).not.toHaveBeenCalled();
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Run run: completed" }).props.onClick(),
  );
  expect(state.getOutput).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { jobId: run.jobId, runId: "run" },
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Full report");
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Run run: completed" }).props.onClick(),
  );
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Full report");
  expect(state.getOutput).toHaveBeenCalledTimes(1);
});

it("opens the targeted task and run immediately on its owning environment", async () => {
  await act(async () => {
    renderer = create(
      <HermesTasksTab
        onNewTask={vi.fn()}
        target={{ environmentId, jobId: run.jobId, runId: "run" }}
      />,
    );
  });
  expect(state.getOutput).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { jobId: run.jobId, runId: "run" },
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Full report");
});

it("does not fetch unavailable output or claim unrecorded session output was delivered", async () => {
  const unavailable = { ...run, delivery: { ...run.delivery!, contentAvailable: false } };
  await act(async () => {
    renderer = create(<HermesRunRow run={unavailable} environmentId={environmentId} targeted />);
  });
  expect(state.getOutput).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer!.toJSON())).toContain("No recorded output is available");
  expect(JSON.stringify(renderer!.toJSON())).toContain("not recorded");
});

it("offers retry after a failed request and reports truncated full output", async () => {
  state.getOutput.mockResolvedValueOnce({ _tag: "Failure" }).mockResolvedValueOnce({
    _tag: "Success",
    value: { content: "Partial report", truncated: true, source: "delivery" },
  });
  await act(async () => {
    renderer = create(<HermesRunRow run={run} environmentId={environmentId} targeted />);
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Could not load");
  const retry = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Retry"))!;
  await act(async () => retry.props.onClick());
  expect(state.getOutput).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Partial report");
  expect(JSON.stringify(renderer!.toJSON())).toContain("Output truncated to the display limit.");
});
