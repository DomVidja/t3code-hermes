// @vitest-environment jsdom
import { EnvironmentId, HermesProfilesError, ProviderInstanceId } from "@t3tools/contracts";
import { Cause } from "effect";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  configure: vi.fn(),
  create: vi.fn(),
  link: vi.fn(),
  refresh: vi.fn(),
}));
const profile = {
  name: "research",
  path: "/fixture/research",
  is_default: false,
  display_name: "Research",
  description: "",
  model: { default: "old", provider: "fixture" },
  reasoning_effort: "high",
  platform_toolsets: { acp: ["hermes-acp"] },
};
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    hermesProfilesList: (args: unknown) => ({ kind: "list", args }),
    hermesProfilesShow: (args: unknown) => ({ kind: "show", args }),
    hermesProfilesConfigure: "configure",
    hermesProfilesCreate: "create",
    hermesProfilesLink: "link",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "configure" | "create" | "link") => state[command],
}));
vi.mock("../../state/hermesInstanceScope", () => ({
  useHermesPanelScope: () => ({
    environmentId: EnvironmentId.make("test"),
    instanceId: ProviderInstanceId.make("hermes-test"),
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { kind: string; args?: { input: { name?: string } } } | null) => ({
    data:
      query?.kind === "list"
        ? { profiles: [{ ...profile, model: "old", provider: "fixture", skill_count: 0 }] }
        : query?.args?.input.name === "research"
          ? profile
          : null,
    error: null,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
import { HermesProfilesTab } from "./HermesProfilesTab";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.configure.mockReset().mockResolvedValue({ _tag: "Success", value: profile });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("requires an explicit second action to confirm the exact guarded-model selection", async () => {
  state.configure.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(
      new HermesProfilesError({
        code: "confirmation_required",
        detail: "Approve fixture model cost",
      }),
    ),
  });
  await act(async () => {
    renderer = create(<HermesProfilesTab />);
  });
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": "Existing Hermes profile" })
      .props.onChange({ target: { value: "research" } }),
  );
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": "Profile model" })
      .props.onChange({ target: { value: "guarded" } }),
  );
  await act(async () =>
    renderer!.root.findAllByType("form")[0]!.props.onSubmit({ preventDefault() {} }),
  );
  expect(state.configure).toHaveBeenCalledTimes(1);
  expect(state.configure.mock.calls[0]?.[0].input).toMatchObject({
    name: "research",
    model: "guarded",
    provider: "fixture",
    instanceId: "hermes-test",
  });
  expect(state.configure.mock.calls[0]?.[0].input.confirmExpensiveModel).toBeUndefined();
  const approve = renderer!.root
    .findAllByType("button")
    .find((node) => node.children.join("").includes("Approve fixture/guarded"));
  expect(approve).toBeDefined();
  await act(async () => approve!.props.onClick());
  expect(state.configure.mock.calls[1]?.[0].input).toMatchObject({
    name: "research",
    model: "guarded",
    provider: "fixture",
    confirmExpensiveModel: true,
  });
});

it("discarding the selected profile removes its pending model confirmation", async () => {
  state.configure.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(
      new HermesProfilesError({
        code: "confirmation_required",
        detail: "Approve fixture model cost",
      }),
    ),
  });
  await act(async () => {
    renderer = create(<HermesProfilesTab />);
  });
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": "Existing Hermes profile" })
      .props.onChange({ target: { value: "research" } }),
  );
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": "Profile model" })
      .props.onChange({ target: { value: "guarded" } }),
  );
  await act(async () =>
    renderer!.root.findAllByType("form")[0]!.props.onSubmit({ preventDefault() {} }),
  );
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": "Existing Hermes profile" })
      .props.onChange({ target: { value: "" } }),
  );
  expect(
    renderer!.root
      .findAllByType("button")
      .some((node) => node.children.join("").includes("Approve fixture/guarded")),
  ).toBe(false);
  expect(state.configure).toHaveBeenCalledTimes(1);
});
