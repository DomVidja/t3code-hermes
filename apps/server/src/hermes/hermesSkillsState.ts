// Node builtins are required here: Effect FileSystem has no O_NOFOLLOW open, lstat, or inode
// identity, which the store-boundary checks below depend on.
// @effect-diagnostics nodeBuiltinImport:off
/** Hermes 0.21 skill files. Bounded, read-only; never follow links into other stores. */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { HermesSkill, HermesSkillDetail, HermesSkillsSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { parseDocument } from "yaml";

import { resolveHermesCronPaths } from "./hermesCronState.ts";

export const SKILL_LIMITS = {
  skills: 1000,
  listBytes: 512 * 1024,
  entries: 12000,
  depth: 12,
  headerBytes: 32 * 1024,
  detailBytes: 128 * 1024,
  sidecarBytes: 8 * 1024 * 1024,
  files: 200,
} as const;

export function resolveHermesSkillsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return NodePath.join(resolveHermesCronPaths(environment).home, "skills");
}

const Frontmatter = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  author: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  license: Schema.optional(Schema.String),
  platforms: Schema.optional(Schema.Array(Schema.String)),
  version: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  metadata: Schema.optional(
    Schema.Struct({
      hermes: Schema.optional(
        Schema.Struct({
          tags: Schema.optional(Schema.Array(Schema.String)),
          related_skills: Schema.optional(Schema.Array(Schema.String)),
          category: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeFrontmatter = Schema.decodeUnknownSync(Frontmatter);
const ManifestEntry = Schema.Struct({ path: Schema.String, sha256: Schema.String });
const LedgerEntry = Schema.Struct({
  id: Schema.String,
  ts: Schema.String,
  actor: Schema.Literals(["agent", "curator", "user"]),
  action: Schema.String,
  skill: Schema.String,
  before: Schema.Array(ManifestEntry),
  after: Schema.Array(ManifestEntry),
});
const decodeLedgerEntry = Schema.decodeUnknownSync(LedgerEntry);
const decodeUsage = Schema.decodeUnknownSync(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      use_count: Schema.optional(Schema.Number),
    }),
  ),
);

function parseSkillDocument(markdown: string) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("Missing skill frontmatter");
  const document = parseDocument(match[1] ?? "");
  if (document.errors.length > 0) throw new Error("Invalid skill frontmatter");
  const data = decodeFrontmatter(document.toJS({ maxAliasCount: 20 }));
  return { data, body: markdown.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, "") };
}

export function parseSkillFrontmatter(markdown: string, path: string) {
  const { data } = parseSkillDocument(markdown);
  return {
    path,
    name: (data.name?.trim() || NodePath.posix.basename(path)).slice(0, 160),
    description: (data.description ?? "").slice(0, 700),
    category: (data.metadata?.hermes?.category?.trim() || NodePath.posix.dirname(path)).slice(
      0,
      160,
    ),
    version: data.version === undefined ? null : String(data.version).slice(0, 40),
    tags: (data.metadata?.hermes?.tags ?? []).slice(0, 16).map((tag) => tag.slice(0, 64)),
  };
}

/** v1 plain names and v2 name:hash lines are both still supported by Hermes. */
export function parseBundledManifest(raw: string): ReadonlySet<string> {
  return new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.split(":", 1)[0]?.trim() ?? "")
      .filter(Boolean),
  );
}

export function parseSkillsLedger(raw: string) {
  const entries: Array<typeof LedgerEntry.Type> = [];
  let malformed = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = decodeLedgerEntry(JSON.parse(line));
      if (!Number.isFinite(Date.parse(entry.ts))) throw new Error("Invalid timestamp");
      entries.push(entry);
    } catch {
      // A writer can be midway through appending the last line. Keep valid history.
      malformed = true;
    }
  }
  return { entries, malformed };
}

export function parseSkillsUsage(raw: string): ReadonlyMap<string, number> {
  const data = decodeUsage(JSON.parse(raw));
  return new Map(
    Object.entries(data).map(([name, entry]) => [
      name,
      Number.isSafeInteger(entry.use_count) && (entry.use_count ?? 0) >= 0
        ? (entry.use_count ?? 0)
        : 0,
    ]),
  );
}

export function enrichSkills(
  skills: readonly ReturnType<typeof parseSkillFrontmatter>[],
  ledger: ReturnType<typeof parseSkillsLedger>,
  bundled: ReadonlySet<string>,
  usage: ReadonlyMap<string, number>,
): readonly HermesSkill[] {
  const names = new Map<string, number>();
  for (const skill of skills) {
    for (const name of new Set([skill.name, NodePath.posix.basename(skill.path)])) {
      names.set(name, (names.get(name) ?? 0) + 1);
    }
  }
  // Index ledger manifests once, not once per skill: large libraries should cost
  // one pass over the audit file, even when a mutation carries many sibling files.
  const knownPaths = new Set(skills.map((skill) => skill.path));
  const byPath = new Map<string, Array<typeof LedgerEntry.Type>>();
  const byName = new Map<string, Array<typeof LedgerEntry.Type>>();
  const add = (
    index: Map<string, Array<typeof LedgerEntry.Type>>,
    key: string,
    entry: typeof LedgerEntry.Type,
  ) => {
    const history = index.get(key);
    if (history) history.push(entry);
    else index.set(key, [entry]);
  };
  for (const entry of ledger.entries) {
    const manifests = [...entry.after, ...entry.before]
      .map((file) => file.path.replaceAll("\\", "/"))
      .filter((file) => file.endsWith("/SKILL.md"));
    if (manifests.length === 0) {
      if (names.get(entry.skill) === 1) add(byName, entry.skill, entry);
      continue;
    }
    const matches = new Set<string>();
    for (const file of manifests) {
      let offset = file.indexOf("/skills/");
      while (offset !== -1) {
        const relative = file.slice(offset + 8, -9);
        if (knownPaths.has(relative)) matches.add(relative);
        offset = file.indexOf("/skills/", offset + 1);
      }
    }
    for (const path of matches) add(byPath, path, entry);
  }
  return skills.map((skill) => {
    const basename = NodePath.posix.basename(skill.path);
    const history = [
      ...new Set([
        ...(byPath.get(skill.path) ?? []),
        ...(byName.get(skill.name) ?? []),
        ...(byName.get(basename) ?? []),
      ]),
    ].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    // A later user recreation is not an agent-created skill just because an old one was.
    const creation = history.findLast((entry) => entry.action === "create");
    const lastHermes = history.findLast(
      (entry) =>
        entry.actor !== "user" &&
        (creation === undefined || Date.parse(entry.ts) >= Date.parse(creation.ts)),
    );
    return {
      ...skill,
      category: skill.category === "." ? "Uncategorized" : skill.category,
      origin:
        bundled.has(skill.name) || bundled.has(basename)
          ? ("bundled" as const)
          : creation && creation.actor !== "user"
            ? ("agent-created" as const)
            : ("user" as const),
      lastModifiedByHermes: lastHermes
        ? DateTime.formatIso(DateTime.makeUnsafe(lastHermes.ts))
        : null,
      usageCount: usage.get(skill.name) ?? usage.get(basename) ?? 0,
    };
  });
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Reads at most `limit` bytes of a regular, singly linked file inside `root`. The opened descriptor
 * must be the file its real path names inside `root`, so a parent directory swapped for a link
 * between traversal or validation and open cannot redirect the read.
 */
async function readBounded(file: string, limit: number, root: string) {
  // O_NOFOLLOW is unavailable on some hosts; reject links before opening there too.
  if (!(await NodeFSP.lstat(file)).isFile()) throw new Error("Not a regular file");
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    // A hard link is indistinguishable from the original, so it could expose a file elsewhere.
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Not a regular file");
    const [real, base] = await Promise.all([NodeFSP.realpath(file), NodeFSP.realpath(root)]);
    const named = await NodeFSP.stat(real);
    if (!real.startsWith(base + NodePath.sep) || named.dev !== stat.dev || named.ino !== stat.ino) {
      throw new Error("Skill file is outside the skills directory");
    }
    const buffer = Buffer.alloc(Math.min(stat.size, limit) + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    return {
      text: buffer.subarray(0, Math.min(bytesRead, limit)).toString("utf8"),
      truncated: bytesRead > limit,
    };
  } finally {
    await handle.close();
  }
}

/** Does not materialize unbounded directory listings or descend into metadata/archive trees. */
async function walk(root: string, fileLimit: number, skillsOnly: boolean) {
  const files: string[] = [];
  let entries = 0;
  let truncated = false;
  const visit = async (relative: string, depth: number): Promise<void> => {
    const directory = await NodeFSP.opendir(NodePath.join(root, relative));
    for await (const item of directory) {
      if (++entries > SKILL_LIMITS.entries || files.length >= fileLimit) {
        truncated = true;
        break;
      }
      if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
      const file = relative ? `${relative}/${item.name}` : item.name;
      if (file.length > 512) {
        truncated = true;
        continue;
      }
      if (item.isDirectory()) {
        if (depth >= SKILL_LIMITS.depth) {
          truncated = true;
          continue;
        }
        await visit(file, depth + 1);
      } else if (item.isFile() && (!skillsOnly || item.name === "SKILL.md")) {
        files.push(file);
      }
    }
  };
  await visit("", 0);
  return { files: files.sort(), truncated };
}

export async function readHermesSkills(
  root: string,
): Promise<Pick<HermesSkillsSnapshot, "availability" | "detail" | "skills" | "truncated">> {
  try {
    const stat = await NodeFSP.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Not a skill directory");
  } catch (error) {
    return {
      availability: isMissing(error) ? "noSkillsStore" : "unreadable",
      detail: isMissing(error) ? null : "The Hermes skills directory could not be read.",
      skills: [],
      truncated: false,
    };
  }
  let incomplete = false;
  const sidecar = async (name: string, fallback: string) => {
    try {
      const value = await readBounded(NodePath.join(root, name), SKILL_LIMITS.sidecarBytes, root);
      if (value.truncated) {
        incomplete = true;
        return fallback;
      }
      return value.text;
    } catch (error) {
      if (!isMissing(error)) incomplete = true;
      return fallback;
    }
  };
  try {
    const listing = await walk(root, SKILL_LIMITS.skills, true);
    const parsed: Array<ReturnType<typeof parseSkillFrontmatter>> = [];
    for (const file of listing.files) {
      try {
        if (file === "SKILL.md") continue;
        parsed.push(
          parseSkillFrontmatter(
            (await readBounded(NodePath.join(root, file), SKILL_LIMITS.headerBytes, root)).text,
            NodePath.posix.dirname(file),
          ),
        );
      } catch {
        incomplete = true;
      }
    }
    if (parsed.length === 0 && listing.files.length > 0 && incomplete) {
      return {
        availability: "unreadable",
        detail: "No readable skill instructions were found in the Hermes skills directory.",
        skills: [],
        truncated: listing.truncated,
      };
    }
    const ledger = parseSkillsLedger(await sidecar(".curator_ledger.jsonl", ""));
    incomplete ||= ledger.malformed;
    const bundled = parseBundledManifest(await sidecar(".bundled_manifest", ""));
    let usage: ReadonlyMap<string, number> = new Map();
    try {
      usage = parseSkillsUsage(await sidecar(".usage.json", "{}"));
    } catch {
      incomplete = true;
    }
    const enriched = enrichSkills(parsed, ledger, bundled, usage);
    const skills: HermesSkill[] = [];
    let listBytes = 0;
    for (const skill of enriched) {
      listBytes += Buffer.byteLength(JSON.stringify(skill));
      if (listBytes > SKILL_LIMITS.listBytes) break;
      skills.push(skill);
    }
    return {
      availability: "ready",
      detail: incomplete
        ? "Some skill files or learning history could not be read. Available skills are shown."
        : null,
      skills,
      truncated: listing.truncated || skills.length < enriched.length,
    };
  } catch {
    return {
      availability: "unreadable",
      detail: "The Hermes skills directory could not be read.",
      skills: [],
      truncated: false,
    };
  }
}

/** Validate each directory, not just the final file: realpath containment alone accepts linked skills. */
export async function readHermesSkillDetail(
  root: string,
  relative: string,
): Promise<HermesSkillDetail> {
  if (
    relative.length > 512 ||
    relative
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.includes("\\") || part.includes(":")) ||
    NodePath.isAbsolute(relative)
  ) {
    throw new Error("Invalid skill path");
  }
  let current = root;
  for (const part of ["", ...relative.split("/")]) {
    current = NodePath.join(current, part);
    const stat = await NodeFSP.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Not a skill directory");
  }
  const content = await readBounded(
    NodePath.join(current, "SKILL.md"),
    SKILL_LIMITS.detailBytes,
    root,
  );
  const listing = await walk(current, SKILL_LIMITS.files, false);
  const { data, body } = parseSkillDocument(content.text);
  return {
    path: relative,
    markdown: body,
    metadata: {
      author:
        (typeof data.author === "string" ? data.author : data.author?.join(", "))?.slice(0, 160) ??
        null,
      license: data.license?.slice(0, 160) ?? null,
      platforms: (data.platforms ?? []).slice(0, 16).map((value) => value.slice(0, 64)),
      relatedSkills: (data.metadata?.hermes?.related_skills ?? [])
        .slice(0, 16)
        .map((value) => value.slice(0, 160)),
    },
    files: listing.files,
    truncated: content.truncated || listing.truncated,
  };
}
