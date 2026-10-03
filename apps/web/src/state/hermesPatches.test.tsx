// @vitest-environment jsdom
import { EnvironmentId, HermesPatchId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  reads: vi.fn(),
  retries: vi.fn(),
  apply: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("./hermesCron", () => ({
  useHermesEnvironmentId: () => EnvironmentId.make("automatic-host"),
}));
vi.mock("./server", () => ({
  serverEnvironment: {
    hermesPatches: (input: unknown) => {
      state.reads(input);
      return input;
    },
    hermesPatchApply: "apply",
    hermesPatchRevert: "remove",
  },
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: (input: unknown) => ({
    data: null,
    error: null,
    isPending: false,
    refresh: () => state.retries(input),
  }),
}));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: (kind: "apply" | "remove") => state[kind],
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
import { HermesPanelScope } from "./hermesInstanceScope";
import { useHermesPatches } from "./hermesPatches";
const patchId = HermesPatchId.make("fixture");
function Harness() {
  const patches = useHermesPatches();
  return (
    <>
      <button onClick={() => patches.apply(patchId)}>apply</button>
      <button onClick={() => patches.remove(patchId)}>remove</button>
      <button onClick={patches.refresh}>retry</button>
    </>
  );
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.reads.mockClear();
  state.retries.mockClear();
  state.apply.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.remove.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("keeps reads, patch mutations and retry on the selected host/instance across A to B to A", async () => {
  for (const selected of ["a", "b", "a"] as const) {
    const scope = {
      environmentId: EnvironmentId.make(`selected-${selected}`),
      instanceId: ProviderInstanceId.make(`hermes-${selected}`),
    };
    await act(async () => {
      const element = (
        <HermesPanelScope value={scope} key={selected}>
          <Harness />
        </HermesPanelScope>
      );
      if (renderer === undefined) renderer = create(element);
      else renderer.update(element);
    });
    const expected = {
      environmentId: scope.environmentId,
      input: { instanceId: scope.instanceId },
    };
    expect(state.reads).toHaveBeenLastCalledWith(expected);
    await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
    expect(state.apply).toHaveBeenLastCalledWith({
      ...expected,
      input: { ...expected.input, patchId },
    });
    await act(async () => renderer!.root.findAllByType("button")[1]!.props.onClick());
    expect(state.remove).toHaveBeenLastCalledWith({
      ...expected,
      input: { ...expected.input, patchId },
    });
    await act(async () => renderer!.root.findAllByType("button")[2]!.props.onClick());
    expect(state.retries).toHaveBeenLastCalledWith(expected);
  }
});
