import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HermesSkillDetail,
  HermesSkillsGetInput,
  HermesSkillsSnapshot,
  HermesSkillsStreamEvent,
} from "./hermesSkills.ts";

const decodeSnapshot = Schema.decodeUnknownSync(HermesSkillsSnapshot);
const decodeDetail = Schema.decodeUnknownSync(HermesSkillDetail);
const decodeGetInput = Schema.decodeUnknownSync(HermesSkillsGetInput);

const snapshot: HermesSkillsSnapshot = {
  contractVersion: 1,
  readAt: "2026-09-29T10:00:00.000Z",
  revision: 1,
  availability: "ready",
  detail: null,
  truncated: false,
  skills: [
    {
      path: "research/example",
      name: "example",
      description: "A learned procedure",
      category: "research",
      version: "1.0.0",
      tags: ["research"],
      origin: "agent-created",
      lastModifiedByHermes: "2026-09-28T10:00:00.000Z",
      usageCount: 3,
    },
  ],
};

describe("Hermes skills wire contract", () => {
  it("round-trips compact snapshots and subscription events", () => {
    const encode = Schema.encodeSync(HermesSkillsStreamEvent);
    const decode = Schema.decodeUnknownSync(HermesSkillsStreamEvent);
    expect(decode(encode({ _tag: "snapshot", snapshot }))).toEqual({ _tag: "snapshot", snapshot });
  });
  it("distinguishes each unavailable state and rejects incompatible versions", () => {
    const decode = Schema.decodeUnknownSync(HermesSkillsSnapshot);
    for (const availability of ["providerDisabled", "noSkillsStore", "unreadable"]) {
      expect(decode({ ...snapshot, availability, skills: [] }).availability).toBe(availability);
    }
    expect(() => decode({ ...snapshot, contractVersion: 2 })).toThrow();
  });
  it("isolates future skill variants instead of losing the whole list", () => {
    const result = decodeSnapshot({
      ...snapshot,
      skills: [...snapshot.skills, { ...snapshot.skills[0], origin: "future-origin" }],
    });
    expect(result.skills).toEqual(snapshot.skills);
  });
  it("fetches read-only detail separately and requires a nonempty path", () => {
    expect(
      decodeDetail({
        path: "research/example",
        markdown: "# Example",
        files: ["SKILL.md"],
        truncated: false,
      }),
    ).toMatchObject({ markdown: "# Example" });
    expect(() => decodeGetInput({ path: " " })).toThrow();
  });
});
