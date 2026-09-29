// @effect-diagnostics nodeBuiltinImport:off
/**
 * Pinned Hermes 0.21.0 samples (2026-09-29). SKILL.md files and selected sidecar
 * rows are copied from a real installation; no credentials or private endpoints.
 * On upgrade, compare tools/{skill_ledger,skill_usage,skills_sync}.py and
 * skill_manager_tool.py with these assertions before updating the fixtures.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import { describe, expect, it } from "vite-plus/test";

import {
  enrichSkills,
  parseBundledManifest,
  parseSkillFrontmatter,
  parseSkillsLedger,
  parseSkillsUsage,
  readHermesSkillDetail,
  readHermesSkills,
  resolveHermesSkillsPath,
  SKILL_LIMITS,
} from "./hermesSkillsState.ts";

const fixtures = NodeURL.fileURLToPath(new URL("./fixtures/skills", import.meta.url));
const markdown =
  "---\nname: example\ndescription: A reusable lesson.\nversion: 1\n---\n# Example\n";
const withDirectory = async (run: (root: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skills-"));
  try {
    await run(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

function mutation(
  actor: "agent" | "curator" | "user",
  action: string,
  ts: string,
  path = "category/example",
) {
  return {
    id: "record",
    ts,
    actor,
    action,
    skill: "example",
    before: [],
    after: [{ path: `/old/home/skills/${path}/SKILL.md`, sha256: "hash" }],
  };
}

it("resolves the same instance-local Hermes home as Tasks", () => {
  expect(resolveHermesSkillsPath({ HERMES_HOME: " /srv/hermes " })).toBe(
    NodePath.join("/srv/hermes", "skills"),
  );
  expect(resolveHermesSkillsPath({ HERMES_HOME: " " })).toBe(
    NodePath.join(NodeOS.homedir(), ".hermes", "skills"),
  );
});

describe("Hermes 0.21 fixtures", () => {
  it("pins skill frontmatter, path, usage, and creation versus mutation provenance", async () => {
    const state = await readHermesSkills(fixtures);
    expect(state.availability).toBe("ready");
    expect(state.detail).toBeNull();
    expect(state.truncated).toBe(false);
    expect(state.skills).toHaveLength(3);
    expect(state.skills.find((s) => s.name === "grounded-citations")).toMatchObject({
      path: "research/grounded-citations",
      category: "research",
      version: "1.2.0",
      tags: ["Research", "Citations", "Grounding", "Sources", "Web", "Reports"],
      origin: "bundled",
      lastModifiedByHermes: null,
      usageCount: 7,
    });
    expect(state.skills.find((s) => s.name === "news-monitor")).toMatchObject({
      origin: "user",
      lastModifiedByHermes: "2026-09-09T06:03:34.203Z",
      usageCount: 1,
    });
    expect(state.skills.find((s) => s.name === "provider-model-availability-triage")).toMatchObject(
      {
        origin: "agent-created",
        category: "autonomous-ai-agents",
        version: "1.0.0",
        lastModifiedByHermes: "2026-09-07T07:34:49.279Z",
        usageCount: 3,
      },
    );
    expect(JSON.stringify(state)).not.toContain("## Steps");
    expect(JSON.stringify(state)).not.toContain("/home/ubuntu");
  });

  it("pins JSONL actors, actions and manifests without mistaking usage adoption for authorship", async () => {
    const ledger = parseSkillsLedger(
      await NodeFSP.readFile(NodePath.join(fixtures, ".curator_ledger.jsonl"), "utf8"),
    );
    expect(ledger.malformed).toBe(false);
    expect(ledger.entries).toHaveLength(5);
    expect(ledger.entries[0]).toMatchObject({
      actor: "curator",
      action: "create",
      skill: "provider-model-availability-triage",
      before: [],
    });
    expect(ledger.entries[1]?.after).toHaveLength(2);
    const usage = parseSkillsUsage(
      await NodeFSP.readFile(NodePath.join(fixtures, ".usage.json"), "utf8"),
    );
    expect([...usage.values()]).toEqual([7, 1, 3]);
    expect(
      parseBundledManifest(
        await NodeFSP.readFile(NodePath.join(fixtures, ".bundled_manifest"), "utf8"),
      ),
    ).toEqual(new Set(["grounded-citations"]));
    expect(parseBundledManifest("old-bundled\nnew-bundled:hash\n")).toEqual(
      new Set(["old-bundled", "new-bundled"]),
    );
  });

  it("fetches complete markdown and relative sibling names only on demand", async () => {
    const detail = await readHermesSkillDetail(
      fixtures,
      "autonomous-ai-agents/provider-model-availability-triage",
    );
    expect(detail.markdown).toContain("# Provider and Model Availability Triage");
    expect(detail.files).toEqual(["SKILL.md", "references/opencode-go-t3code.md"]);
    expect(detail.truncated).toBe(false);
  });
});

it("ignores malformed ledger lines but preserves valid records and warns", () => {
  const entry = mutation("agent", "create", "2026-09-01T00:00:00Z");
  const result = parseSkillsLedger(
    `${JSON.stringify(entry)}\n{partial\n${JSON.stringify({ ...entry, ts: "invalid" })}`,
  );
  expect(result.entries).toHaveLength(1);
  expect(result.malformed).toBe(true);
});

it("uses latest creation, sorts timestamps, excludes user edits and keeps bundled origin", () => {
  const skill = parseSkillFrontmatter(markdown, "category/example");
  const ledger = parseSkillsLedger(
    [
      mutation("user", "patch", "2026-09-04T00:00:00Z"),
      mutation("curator", "patch", "2026-09-03T00:00:00Z"),
      mutation("agent", "create", "2026-09-01T00:00:00Z"),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  expect(enrichSkills([skill], ledger, new Set(), new Map())[0]).toMatchObject({
    origin: "agent-created",
    lastModifiedByHermes: "2026-09-03T00:00:00.000Z",
  });
  expect(enrichSkills([skill], ledger, new Set(["example"]), new Map())[0]?.origin).toBe("bundled");
  const recreated = {
    ...ledger,
    entries: [...ledger.entries, mutation("user", "create", "2026-09-05T00:00:00Z")],
  };
  expect(enrichSkills([skill], recreated, new Set(), new Map())[0]).toMatchObject({
    origin: "user",
    lastModifiedByHermes: null,
  });
});

it("does not attribute changes to another category's same-named skill", () => {
  const skills = ["a/example", "b/example"].map((path) => parseSkillFrontmatter(markdown, path));
  const ledger = parseSkillsLedger(
    JSON.stringify(mutation("agent", "create", "2026-09-01T00:00:00Z", "a/example")),
  );
  expect(enrichSkills(skills, ledger, new Set(), new Map()).map((s) => s.origin)).toEqual([
    "agent-created",
    "user",
  ]);
});

it("bounds metadata and rejects malformed YAML", () => {
  const skill = parseSkillFrontmatter(
    `---\nname: example\ndescription: ${"x".repeat(2000)}\n---\n`,
    "category/example",
  );
  expect(skill.description).toHaveLength(700);
  expect(() => parseSkillFrontmatter("---\nname: [\n---\n", "broken")).toThrow();
  expect(() => parseSkillFrontmatter("no frontmatter", "broken")).toThrow();
  expect(parseSkillsUsage('{"skill":{"use_count":-2}}').get("skill")).toBe(0);
});

it("distinguishes missing, empty and unreadable stores; skips archives and broken skills", async () => {
  await withDirectory(async (root) => {
    expect((await readHermesSkills(NodePath.join(root, "missing"))).availability).toBe(
      "noSkillsStore",
    );
    expect((await readHermesSkills(root)).skills).toEqual([]);
    await NodeFSP.writeFile(NodePath.join(root, "file"), "not a directory");
    expect((await readHermesSkills(NodePath.join(root, "file"))).availability).toBe("unreadable");
    for (const dir of ["category/deeper/example", ".archive/example", "bad"]) {
      await NodeFSP.mkdir(NodePath.join(root, dir), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(root, dir, "SKILL.md"),
        dir === "bad" ? "invalid" : markdown,
      );
    }
    const result = await readHermesSkills(root);
    expect(result.skills.map((s) => s.path)).toEqual(["category/deeper/example"]);
    expect(result.detail).not.toBeNull();
  });
});

it("caps the compact websocket list for a large library without loading bodies", async () => {
  await withDirectory(async (root) => {
    const tags = Array.from({ length: 16 }, () => "知".repeat(64)).join(", ");
    const text = `---\nname: example\ndescription: ${"知".repeat(700)}\nmetadata:\n  hermes:\n    tags: [${tags}]\n---\n# Body must stay on demand\n`;
    for (let i = 0; i < 220; i++) {
      const directory = NodePath.join(root, `skill-${String(i).padStart(3, "0")}`);
      await NodeFSP.mkdir(directory);
      await NodeFSP.writeFile(NodePath.join(directory, "SKILL.md"), text);
    }
    const result = await readHermesSkills(root);
    expect(result.availability).toBe("ready");
    expect(result.truncated).toBe(true);
    expect(result.skills.length).toBeGreaterThan(0);
    expect(result.skills.length).toBeLessThan(220);
    expect(Buffer.byteLength(JSON.stringify(result.skills))).toBeLessThan(
      SKILL_LIMITS.listBytes + 1000,
    );
    expect(JSON.stringify(result)).not.toContain("Body must stay on demand");
  });
});

it("bounds detail bytes and excludes hidden or linked files", async () => {
  await withDirectory(async (root) => {
    await NodeFSP.mkdir(NodePath.join(root, "example"));
    await NodeFSP.writeFile(
      NodePath.join(root, "example/SKILL.md"),
      markdown + "x".repeat(SKILL_LIMITS.detailBytes),
    );
    await NodeFSP.writeFile(NodePath.join(root, "example/.env"), "private");
    const detail = await readHermesSkillDetail(root, "example");
    expect(Buffer.byteLength(detail.markdown)).toBe(SKILL_LIMITS.detailBytes);
    expect(detail.truncated).toBe(true);
    expect(detail.files).toEqual(["SKILL.md"]);
    for (const path of [
      "../example",
      "/etc",
      "example/..",
      "example\\secret",
      ".archive/example",
    ]) {
      await expect(readHermesSkillDetail(root, path)).rejects.toThrow();
    }
    if (symlinksSupported) {
      await NodeFSP.symlink(NodePath.join(root, "example"), NodePath.join(root, "linked"));
      await expect(readHermesSkillDetail(root, "linked")).rejects.toThrow();
      expect((await readHermesSkills(root)).skills.map((s) => s.path)).toEqual(["example"]);
    }
  });
});
