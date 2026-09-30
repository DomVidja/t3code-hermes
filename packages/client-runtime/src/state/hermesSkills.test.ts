import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type HermesSkill, type HermesSkillsSnapshot } from "@t3tools/contracts";

import {
  describeHermesSkillsEmptyState,
  formatHermesSkillUpdated,
  formatHermesSkillMetadata,
  hermesSkillDetailInput,
  resolveHermesSkillSelection,
  selectHermesSkills,
} from "./hermesSkills.ts";

function skill(path: string, overrides: Partial<HermesSkill> = {}): HermesSkill {
  return {
    path,
    name: path,
    description: "",
    category: "Development",
    version: null,
    tags: [],
    origin: "bundled",
    lastModifiedByHermes: null,
    usageCount: 0,
    ...overrides,
  };
}

function snapshot(
  skills: readonly HermesSkill[],
  overrides: Partial<HermesSkillsSnapshot> = {},
): HermesSkillsSnapshot {
  return {
    contractVersion: 1,
    revision: 1,
    readAt: "2026-09-29T12:00:00Z",
    availability: "ready",
    detail: null,
    skills,
    truncated: false,
    ...overrides,
  };
}

describe("Hermes Skills library", () => {
  it("invalidates detail on same-tick store changes and reconnects with identical metadata", () => {
    const skills = [skill("example")];
    const initial = snapshot(skills);
    const current = hermesSkillDetailInput("example", initial);
    expect(hermesSkillDetailInput("example", { ...initial })).toEqual(current);
    expect(hermesSkillDetailInput("example", snapshot(skills, { revision: 2 }))).not.toEqual(
      current,
    );
    expect(
      hermesSkillDetailInput("example", snapshot(skills, { readAt: "2026-09-29T12:01:00Z" })),
    ).not.toEqual(current);
    expect(hermesSkillDetailInput("another", initial)).not.toEqual(current);
  });

  it("groups and sorts the metadata without changing source order", () => {
    const skills = Object.freeze([
      skill("z", { category: "Writing" }),
      skill("b"),
      skill("a"),
      skill("other", { category: " " }),
    ]);
    const view = selectHermesSkills(skills, "", "all");
    expect(
      view.groups.map((group) => [group.category, group.skills.map((entry) => entry.path)]),
    ).toEqual([
      ["Development", ["a", "b"]],
      ["Uncategorized", ["other"]],
      ["Writing", ["z"]],
    ]);
    expect(skills.map((entry) => entry.path)).toEqual(["z", "b", "a", "other"]);
    expect(view.count).toBe(4);
  });

  it("combines origin and case-insensitive metadata search, including tags and paths", () => {
    const skills = [
      skill("work/review", {
        origin: "agent-created",
        tags: ["Quality"],
        lastModifiedByHermes: "2026-09-29T11:00:00Z",
      }),
      skill("bundled/review", { tags: ["Quality"] }),
      skill("work/docs", { origin: "user", description: "Quality writing" }),
    ];
    expect(
      selectHermesSkills(skills, " QUALITY ", "agent-created").groups[0]?.skills.map(
        (entry) => entry.path,
      ),
    ).toEqual(["work/review"]);
    expect(selectHermesSkills(skills, "WORK/", "all").count).toBe(2);
    expect(selectHermesSkills(skills, "writing", "user").count).toBe(1);
    expect(selectHermesSkills(skills, "Development", "bundled").count).toBe(1);
    expect(selectHermesSkills(skills, "absent", "all").recent).toEqual([]);
  });

  it("shows only the five latest known Hermes changes, respecting filters", () => {
    const skills = Array.from({ length: 7 }, (_, index) =>
      skill(`skill-${index}`, {
        origin: index === 6 ? "user" : "agent-created",
        lastModifiedByHermes: `2026-09-29T0${index}:00:00Z`,
      }),
    );
    skills.push(skill("unknown"), skill("invalid", { lastModifiedByHermes: "not a date" }));
    expect(selectHermesSkills(skills, "", "all").recent.map((entry) => entry.path)).toEqual([
      "skill-6",
      "skill-5",
      "skill-4",
      "skill-3",
      "skill-2",
    ]);
    expect(selectHermesSkills(skills, "", "agent-created").recent[0]?.path).toBe("skill-5");
  });

  it("never carries a detail selection across environments or unavailable snapshots", () => {
    const first = EnvironmentId.make("first");
    const second = EnvironmentId.make("second");
    const selected = { environmentId: first, path: "review" };
    const current = skill("review");
    expect(resolveHermesSkillSelection(selected, first, snapshot([current]))).toBe(current);
    expect(resolveHermesSkillSelection(selected, second, snapshot([current]))).toBeNull();
    expect(resolveHermesSkillSelection(selected, null, snapshot([current]))).toBeNull();
    expect(resolveHermesSkillSelection(selected, first, null)).toBeNull();
    expect(resolveHermesSkillSelection(selected, first, snapshot([]))).toBeNull();
    expect(
      resolveHermesSkillSelection(
        selected,
        first,
        snapshot([current], { availability: "providerDisabled" }),
      ),
    ).toBeNull();
    expect(resolveHermesSkillSelection(null, first, snapshot([current]))).toBeNull();
  });

  it("distinguishes store, provider, read failures, and an empty ready library", () => {
    expect(describeHermesSkillsEmptyState(null)).toBeNull();
    expect(describeHermesSkillsEmptyState(snapshot([skill("review")]))).toBeNull();
    expect(describeHermesSkillsEmptyState(snapshot([]))?.title).toBe("No skills yet");
    expect(
      describeHermesSkillsEmptyState(snapshot([], { availability: "noSkillsStore" }))?.title,
    ).toBe("No skills store yet");
    expect(
      describeHermesSkillsEmptyState(snapshot([], { availability: "providerDisabled" }))?.title,
    ).toBe("Hermes is not enabled here");
    expect(
      describeHermesSkillsEmptyState(
        snapshot([], { availability: "unreadable", detail: "Permission denied" }),
      )?.description,
    ).toBe("Permission denied");
  });

  it("formats relative Hermes update time without inventing unknown timestamps", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(formatHermesSkillUpdated(null, now)).toBeNull();
    expect(formatHermesSkillUpdated("invalid", now)).toBeNull();
    expect(formatHermesSkillUpdated("2026-09-29T13:00:00Z", now)).toBe(
      "Updated by Hermes just now",
    );
    expect(formatHermesSkillUpdated("2026-09-29T11:55:00Z", now)).toBe("Updated by Hermes 5m ago");
    expect(formatHermesSkillUpdated("2026-09-29T09:00:00Z", now)).toBe("Updated by Hermes 3h ago");
    expect(formatHermesSkillUpdated("2026-09-27T12:00:00Z", now)).toBe("Updated by Hermes 2d ago");
  });
});

it("formats document metadata without empty labels or YAML syntax", () => {
  expect(formatHermesSkillMetadata(undefined)).toBeNull();
  expect(
    formatHermesSkillMetadata({ author: null, license: null, platforms: [], relatedSkills: [] }),
  ).toBeNull();
  expect(
    formatHermesSkillMetadata({
      author: "Hermes Agent",
      license: "MIT",
      platforms: ["linux", "macos"],
      relatedSkills: ["research"],
    }),
  ).toBe(
    "Author: Hermes Agent · License: MIT · Platforms: linux, macos · Related skills: research",
  );
});
