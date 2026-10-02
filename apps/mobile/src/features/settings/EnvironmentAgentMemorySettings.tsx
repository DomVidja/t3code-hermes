import { useAtomValue } from "@effect/atom-react";
import { describeHindsightAgentMemory } from "@t3tools/client-runtime/state/hindsight";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/**
 * Hindsight for every agent, mirroring the web Providers settings: the switch
 * saves `integrations.hindsight.agentMemory`, and the environment wires its own
 * agents and reports back where each one stands.
 */
export function EnvironmentAgentMemorySettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const enabled = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.integrations
    .hindsight.agentMemory;
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

  if (enabled === undefined) return null;

  const state = stateQuery.data ?? null;
  // An environment that predates agent memory rejects the subscription outright.
  const unavailable = state === null && stateQuery.error !== null;
  const summary = unavailable
    ? {
        label: "Unavailable",
        detail: "Update T3 Code on this environment.",
        tone: "attention",
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
    <>
      <SettingsSwitchRow
        icon="brain"
        label="Hindsight for every agent"
        subtitle={summary.detail === null ? summary.label : `${summary.label} · ${summary.detail}`}
        disabled={busy}
        value={enabled}
        onValueChange={(next) => void setEnabled(next)}
      />
      {summary.agents.length === 0 ? null : (
        <View className="gap-1 px-4 pb-4">
          {summary.agents.map((agent) => (
            <Text
              key={agent.target}
              selectable
              className={
                agent.tone === "attention"
                  ? "text-sm text-danger-foreground"
                  : "text-sm text-foreground-muted"
              }
            >
              {[agent.label, agent.status, agent.detail]
                .filter((part) => part !== null)
                .join(" · ")}
            </Text>
          ))}
        </View>
      )}
      {enabled && summary.tone === "attention" && !unavailable ? (
        <SettingsActionRow
          icon="arrow.clockwise"
          label="Retry Hindsight setup"
          disabled={busy}
          loading={state?.applying === true}
          onPress={() => void apply({ environmentId, input: {} })}
        />
      ) : null}
    </>
  );
}
