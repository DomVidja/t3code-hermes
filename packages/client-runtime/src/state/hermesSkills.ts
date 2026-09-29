import type { EnvironmentId, HermesSkill, HermesSkillsSnapshot } from "@t3tools/contracts";
import { DateTime } from "effect";

export type HermesSkillOriginFilter = "all" | HermesSkill["origin"];

export const HERMES_SKILL_ORIGIN_FILTERS = ["all", "bundled", "user", "agent-created"] as const;
export const HERMES_SKILL_ORIGIN_LABELS = {
  all: "All origins",
  bundled: "Bundled",
  user: "User",
  "agent-created": "Hermes-created",
} as const;

/** Both clients search compact metadata, never fetching Markdown to filter. */
export function selectHermesSkills(
  skills: readonly HermesSkill[],
  search: string,
  origin: HermesSkillOriginFilter,
) {
  const query = search.trim().toLocaleLowerCase();
  const filtered = skills.filter(
    (skill) =>
      (origin === "all" || skill.origin === origin) &&
      (query.length === 0 ||
        [skill.name, skill.description, skill.category, skill.path, ...skill.tags].some((value) =>
          value.toLocaleLowerCase().includes(query),
        )),
  );
  const categories = new Map<string, HermesSkill[]>();
  for (const skill of filtered) {
    const category = skill.category.trim() || "Uncategorized";
    const group = categories.get(category);
    if (group) group.push(skill);
    else categories.set(category, [skill]);
  }
  const groups = Array.from(categories, ([category, entries]) => ({
    category,
    skills: entries.sort(
      (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    ),
  })).sort((left, right) => left.category.localeCompare(right.category));
  const recent = filtered
    .flatMap((skill) => {
      const timestamp =
        skill.lastModifiedByHermes === null ? NaN : Date.parse(skill.lastModifiedByHermes);
      return Number.isFinite(timestamp) ? [{ skill, timestamp }] : [];
    })
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp || left.skill.path.localeCompare(right.skill.path),
    )
    .slice(0, 5)
    .map(({ skill }) => skill);
  return { groups, recent, count: filtered.length };
}

export function formatHermesSkillUpdated(
  value: string | null,
  now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "Updated by Hermes just now";
  if (elapsed < 3_600_000) return `Updated by Hermes ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `Updated by Hermes ${Math.floor(elapsed / 3_600_000)}h ago`;
  return `Updated by Hermes ${Math.floor(elapsed / 86_400_000)}d ago`;
}

export function describeHermesSkillsEmptyState(snapshot: HermesSkillsSnapshot | null) {
  if (snapshot === null) return null;
  switch (snapshot.availability) {
    case "providerDisabled":
      return {
        title: "Hermes is not enabled here",
        description: "Turn on the Hermes provider in Settings to see its skills.",
      };
    case "unreadable":
      return {
        title: "Hermes skills could not be read",
        description: snapshot.detail ?? "The skills store could not be read.",
      };
    case "noSkillsStore":
      return {
        title: "No skills store yet",
        description: "Skills will appear here once Hermes has a skills store on this environment.",
      };
    case "ready":
      return snapshot.skills.length === 0
        ? {
            title: "No skills yet",
            description: "Ask Hermes in chat to create a skill. This library is read-only.",
          }
        : null;
  }
}

export interface HermesSkillSelection {
  readonly environmentId: EnvironmentId;
  readonly path: string;
}

/** A selection belongs to its environment; removed or unavailable skills close immediately. */
export function resolveHermesSkillSelection(
  selection: HermesSkillSelection | null,
  environmentId: EnvironmentId | null,
  snapshot: HermesSkillsSnapshot | null,
): HermesSkill | null {
  if (selection?.environmentId !== environmentId || snapshot?.availability !== "ready") return null;
  return snapshot.skills.find((skill) => skill.path === selection?.path) ?? null;
}

/** Store changes can preserve all skill metadata; readAt also separates server restarts. */
export function hermesSkillDetailInput(path: string, snapshot: HermesSkillsSnapshot) {
  return { path, revision: `${snapshot.readAt}:${snapshot.revision}` };
}
