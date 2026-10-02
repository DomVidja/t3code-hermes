import { describe, expect, it } from "vite-plus/test";

import { describeHindsightAgentMemory } from "./hindsight.ts";

const base = { applying: false, blocker: null, agents: [], detail: null } as const;

describe("describeHindsightAgentMemory", () => {
  it("names the blocker before anything else, so the switch says what to fix", () => {
    expect(
      describeHindsightAgentMemory({ ...base, blocker: "notConfigured" }, { enabled: true }).label,
    ).toBe("No Hindsight server");
    expect(
      describeHindsightAgentMemory({ ...base, blocker: "nodeMissing" }, { enabled: true }).label,
    ).toBe("Node.js not found");
  });

  it("only reads as on when every agent is actually wired", () => {
    const wired = { target: "codex", state: "installed", detail: null } as const;
    // Fully wired needs no headline: the switch already says it is on.
    expect(
      describeHindsightAgentMemory({ ...base, agents: [wired] }, { enabled: true }),
    ).toMatchObject({ tone: "ready", label: null });
    const summary = describeHindsightAgentMemory(
      {
        ...base,
        agents: [wired, { target: "hermes", state: "failed", detail: "config.yaml did not parse" }],
      },
      { enabled: true },
    );
    expect(summary.tone).toBe("attention");
    expect(summary.agents[0]?.status).toBeNull();
    expect(summary.agents[1]).toMatchObject({ label: "Hermes", status: "Failed" });
  });

  it("reports an in-flight pass instead of a stale verdict", () => {
    expect(
      describeHindsightAgentMemory(
        { ...base, applying: true, blocker: "nodeMissing" },
        { enabled: true },
      ).label,
    ).toBe("Applying…");
  });
});
