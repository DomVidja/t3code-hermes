/** Read-only window onto the skill library owned by this environment's Hermes. */
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HERMES_SKILLS_CONTRACT_VERSION = 1 as const;

export const HermesSkill = Schema.Struct({
  /** Relative directory beneath HERMES_HOME/skills; also the stable detail key. */
  path: TrimmedNonEmptyString,
  name: Schema.String,
  description: Schema.String,
  category: Schema.String,
  version: Schema.NullOr(Schema.String),
  tags: ForwardCompatibleArray(Schema.String),
  origin: Schema.Literals(["bundled", "user", "agent-created"]),
  /** Agent and curator mutations only, never filesystem mtime or user edits. */
  lastModifiedByHermes: Schema.NullOr(IsoDateTime),
  usageCount: Schema.Number,
});
export type HermesSkill = typeof HermesSkill.Type;

export const HermesSkillsSnapshot = Schema.Struct({
  contractVersion: Schema.Literal(HERMES_SKILLS_CONTRACT_VERSION),
  readAt: IsoDateTime,
  /** Changes when metadata or the selected Hermes home changes, without exposing host paths. */
  revision: Schema.Number,
  availability: Schema.Literals(["ready", "providerDisabled", "noSkillsStore", "unreadable"]),
  detail: Schema.NullOr(Schema.String),
  skills: ForwardCompatibleArray(HermesSkill),
  truncated: Schema.Boolean,
});
export type HermesSkillsSnapshot = typeof HermesSkillsSnapshot.Type;

export const HermesSkillDetail = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** Markdown body, with the YAML frontmatter removed. */
  markdown: Schema.String,
  metadata: Schema.Struct({
    author: Schema.NullOr(Schema.String),
    license: Schema.NullOr(Schema.String),
    platforms: ForwardCompatibleArray(Schema.String),
    relatedSkills: ForwardCompatibleArray(Schema.String),
  }),
  /** Relative file names only; no file contents except SKILL.md cross the wire. */
  files: ForwardCompatibleArray(Schema.String),
  truncated: Schema.Boolean,
});
export type HermesSkillDetail = typeof HermesSkillDetail.Type;

export const HermesSkillsStreamEvent = Schema.Struct({
  _tag: Schema.tag("snapshot"),
  snapshot: HermesSkillsSnapshot,
});
export type HermesSkillsStreamEvent = typeof HermesSkillsStreamEvent.Type;

export const HermesSkillsListInput = Schema.Struct({ refresh: Schema.optionalKey(Schema.Boolean) });
export const HermesSkillsGetInput = Schema.Struct({ path: TrimmedNonEmptyString });
export type HermesSkillsGetInput = typeof HermesSkillsGetInput.Type;

export class HermesSkillsError extends Schema.TaggedError<HermesSkillsError>()(
  "HermesSkillsError",
  {
    reason: Schema.Literals(["providerDisabled", "unknownSkill", "unreadable"]),
    /** Stable, bounded description. The underlying failure travels in `cause`. */
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Hermes skills request failed (${this.reason}): ${this.detail}`;
  }
}
