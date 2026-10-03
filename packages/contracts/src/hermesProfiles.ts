import * as Schema from "effect/Schema";
import { HermesInstanceScope } from "./hermesInstance.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const text = Schema.String.check(Schema.isMaxLength(512));
export const HermesProfileName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,79}$/),
);
export const HermesProfile = Schema.Struct({
  name: HermesProfileName,
  path: Schema.String,
  is_default: Schema.Boolean,
  description: Schema.String,
  display_name: Schema.String,
  model: Schema.Struct({ default: Schema.String, provider: Schema.String }),
  reasoning_effort: Schema.String,
  platform_toolsets: Schema.Struct({
    cli: Schema.optionalKey(Schema.Array(Schema.String)),
    acp: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
});
export type HermesProfile = typeof HermesProfile.Type;
export const HermesProfileList = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({
      name: HermesProfileName,
      path: Schema.String,
      is_default: Schema.Boolean,
      model: Schema.NullOr(Schema.String),
      provider: Schema.NullOr(Schema.String),
      description: Schema.String,
      display_name: Schema.String,
      skill_count: Schema.Number,
    }),
  ),
});
export const HermesProfileListInput = HermesInstanceScope;
export const HermesProfileShowInput = Schema.Struct({
  ...HermesInstanceScope.fields,
  name: HermesProfileName,
});
export const HermesProfileCreateInput = Schema.Struct({
  ...HermesProfileShowInput.fields,
  description: Schema.optionalKey(text),
  noSkills: Schema.optionalKey(Schema.Boolean),
});
export const HermesProfileConfigureInput = Schema.Struct({
  ...HermesProfileShowInput.fields,
  model: Schema.optionalKey(text),
  provider: Schema.optionalKey(text),
  reasoningEffort: Schema.optionalKey(
    Schema.Literals(["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  ),
  toolsets: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  confirmExpensiveModel: Schema.optionalKey(Schema.Boolean),
});
export type HermesProfileConfigureInput = typeof HermesProfileConfigureInput.Type;
export const HermesProfileLinkInput = Schema.Struct({
  ...HermesProfileShowInput.fields,
  newInstanceId: ProviderInstanceId,
  displayName: text,
});
export const HermesProfileLinkResult = Schema.Struct({ instanceId: ProviderInstanceId });
export class HermesProfilesError extends Schema.TaggedError<HermesProfilesError>()(
  "HermesProfilesError",
  {
    code: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
