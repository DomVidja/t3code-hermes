import * as Schema from "effect/Schema";
import {
  HermesProfileDelegationInput,
  HermesProfileDelegationResult,
  HermesProfileDelegationError,
  HermesProfileDelegationTarget,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Delegation from "../../../hermes/HermesProfileDelegationService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

export const ProfileDelegationToolkit = Toolkit.make(
  Tool.make("list_profile_delegation_targets", {
    description:
      "List the explicitly allowed Hermes profile targets for delegation from this live session. Call before delegate_to_profile to obtain trusted target instance IDs.",
    parameters: Schema.Struct({ targetInstanceId: Schema.optional(ProviderInstanceId) }),
    success: Schema.Array(HermesProfileDelegationTarget),
    failure: HermesProfileDelegationError,
    dependencies: [Invocation.McpInvocationContext, Delegation.HermesProfileDelegationService],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),

  Tool.make("delegate_to_profile", {
    description:
      "Run a bounded coding or research task in an explicitly allowed Hermes profile, using its model and profile context. Child tools are limited to supervised file, terminal, web research, skill reading, vision and todo tools. Scheduling, Kanban, browser, computer use, MCP and nested delegation are unavailable in this child. Permission requests appear in this parent thread. Returns the child's actual result. Call list_profile_delegation_targets first.",
    parameters: HermesProfileDelegationInput,
    success: HermesProfileDelegationResult,
    failure: HermesProfileDelegationError,
    dependencies: [Invocation.McpInvocationContext, Delegation.HermesProfileDelegationService],
  })
    .annotate(Tool.Title, "Delegate to Hermes profile")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true),
);
