/**
 * Hindsight for every agent — the Providers settings switch for agent memory.
 *
 * The switch only saves `integrations.hindsight.agentMemory`; the environment
 * does the wiring on its own host and streams where each agent stands, so the
 * rows below report what the agents' config actually says, not what the switch
 * hopes. Follows the device selected for provider settings, remote ones too.
 *
 * @module HindsightAgentMemorySettings
 */
import { describeHindsightAgentMemory } from "@t3tools/client-runtime/state/hindsight";
import type { EnvironmentId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function ToneDot({ tone }: { readonly tone: "ready" | "attention" | "idle" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "ready"
          ? "bg-success"
          : tone === "attention"
            ? "bg-warning"
            : "bg-muted-foreground/40",
      )}
    />
  );
}

export function HindsightAgentMemorySettings({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const enabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.integrations.hindsight.agentMemory,
  );
  const stateQuery = useEnvironmentQuery(
    serverEnvironment.hindsightAgentMemory({ environmentId, input: {} }),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Hindsight agent memory",
  });
  const apply = useAtomCommand(serverEnvironment.applyHindsightAgentMemory, {
    label: "apply Hindsight agent memory",
  });
  const [saving, setSaving] = useState(false);

  const state = stateQuery.data ?? null;
  // An environment that predates agent memory rejects the subscription outright.
  const unavailable = state === null && stateQuery.error !== null;
  const summary = unavailable
    ? {
        tone: "attention" as const,
        label: "Unavailable",
        detail: "Update T3 Code on this device to use this.",
        agents: [],
      }
    : describeHindsightAgentMemory(state, { enabled });
  const busy = saving || unavailable || state?.applying === true;

  const setEnabled = async (agentMemory: boolean) => {
    setSaving(true);
    try {
      await updateSettings({
        environmentId,
        input: { patch: { integrations: { hindsight: { agentMemory } } } },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Memory">
      <SettingsRow
        {...searchableSetting("agent-memory")}
        description="Give Claude Code, Codex, and Hermes on this device long-term memory in the Hindsight server set up under Integrations → Memory. Turning it off removes only what T3 Code added."
        status={
          <ul className="flex flex-col gap-1 text-xs">
            {summary.label === null ? null : (
              <li className="flex min-w-0 items-center gap-2">
                <ToneDot tone={summary.tone} />
                <span className="font-medium text-foreground">{summary.label}</span>
                {summary.detail === null ? null : (
                  <span className="min-w-0 truncate text-muted-foreground">{summary.detail}</span>
                )}
              </li>
            )}
            {summary.agents.map((agent) => (
              <li key={agent.target} className="flex min-w-0 items-center gap-2">
                <ToneDot tone={agent.tone} />
                <span className="font-medium text-foreground">{agent.label}</span>
                {agent.status === null ? null : (
                  <span className="text-muted-foreground">{agent.status}</span>
                )}
                {agent.detail === null ? null : (
                  <span className="min-w-0 truncate text-muted-foreground">{agent.detail}</span>
                )}
              </li>
            ))}
          </ul>
        }
        control={
          <div className="flex items-center gap-2">
            {enabled && summary.tone === "attention" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly || busy}
                onClick={() => void apply({ environmentId, input: {} })}
              >
                <RefreshCwIcon />
                Retry
              </Button>
            ) : null}
            <Switch
              checked={enabled}
              disabled={readOnly || busy}
              aria-label="Hindsight for every agent"
              onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
