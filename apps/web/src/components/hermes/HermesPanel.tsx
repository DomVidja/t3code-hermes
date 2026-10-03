/**
 * Hermes panel — a full-page view opened from the sidebar, mirroring Usage.
 *
 * Four tabs: Tasks (Hermes's scheduled jobs), Memory (what the agent
 * remembers, via Hindsight), Patches (the fork's patches to Hermes itself),
 * and Skills (Hermes's learned procedures). The tab list is data, so adding
 * one is an entry plus a component.
 *
 * Every tab renders unconditionally and speak for themselves when their backing
 * service is absent. A tab that appears only once a network read lands would
 * shift the strip after mount and would hide the one screen that tells someone
 * whether the thing they just configured is working.
 */
import { HERMES_NEW_TASK_TEMPLATE } from "@t3tools/client-runtime/state/hermes-cron";
import { useAtomValue } from "@effect/atom-react";
import { ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { HermesPanelScope } from "../../state/hermesInstanceScope";
import { serverEnvironment } from "../../state/server";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { requestComposerTemplate } from "../../composerTemplateBus";
import { cn } from "../../lib/utils";
import { markHermesTasksSeen } from "../../state/hermesCronSeen";
import { useHermesEnvironmentId } from "../../state/hermesCron";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { HermesMemoryTab } from "./HermesMemoryTab";
import { HermesPatchesTab } from "./HermesPatchesTab";
import { HermesTasksTab } from "./HermesTasksTab";
import { HermesProfilesTab } from "./HermesProfilesTab";
import { HermesSkillsTab } from "./HermesSkillsTab";
import { HermesKanbanTab } from "./HermesKanbanTab";
import { EMPTY_HERMES_SEARCH, type HermesSearch } from "./hermesNavigation";

type HermesTab = "tasks" | "kanban" | "memory" | "patches" | "skills" | "profiles";

const TABS: ReadonlyArray<{ readonly value: HermesTab; readonly label: string }> = [
  { value: "tasks", label: "Tasks" },
  { value: "kanban", label: "Kanban" },
  { value: "memory", label: "Memory" },
  { value: "patches", label: "Patches" },
  { value: "skills", label: "Skills" },
  { value: "profiles", label: "Profiles" },
];

export function HermesPanel({ target = EMPTY_HERMES_SEARCH }: { readonly target?: HermesSearch }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<HermesTab>("tasks");
  const automaticEnvironmentId = useHermesEnvironmentId();
  const environmentId = target.environmentId ?? automaticEnvironmentId;

  const [instanceId, setInstanceId] = useState<ProviderInstanceId | undefined>();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const instances = deriveProviderInstanceEntries(config?.providers ?? []).filter(
    (entry) => entry.driverKind === "hermes" && entry.enabled,
  );

  const selectedInstanceId =
    instanceId ?? (instances.find((entry) => entry.isDefault) ?? instances[0])?.instanceId;

  const targetKey = JSON.stringify([target.environmentId, target.jobId, target.runId]);
  const [previousTarget, setPreviousTarget] = useState(targetKey);
  if (targetKey !== previousTarget) {
    setPreviousTarget(targetKey);
    if (target.jobId) setTab("tasks");
  }

  // Opening the panel is what clears the sidebar's unread dot.
  useEffect(() => {
    if (environmentId !== null) markHermesTasksSeen(environmentId);
  }, [environmentId]);

  const handleNewTask = useCallback(() => {
    requestComposerTemplate(HERMES_NEW_TASK_TEMPLATE);
    void navigate({ to: "/" });
  }, [navigate]);

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 px-4 py-3">
          <WorkspaceBreadcrumb ariaLabel="Hermes breadcrumb">
            <WorkspaceBreadcrumbItem current>Hermes</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            Hermes profile
            <select
              aria-label="Hermes profile"
              value={instanceId ?? ""}
              onChange={(event) =>
                setInstanceId(
                  event.target.value ? ProviderInstanceId.make(event.target.value) : undefined,
                )
              }
              className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
            >
              <option value="">Environment default</option>
              {instances.map((entry) => (
                <option key={entry.instanceId} value={entry.instanceId}>
                  {entry.displayName}
                </option>
              ))}
              {instanceId !== undefined &&
              !instances.some((entry) => entry.instanceId === instanceId) ? (
                <option value={instanceId}>Unavailable profile ({instanceId})</option>
              ) : null}
            </select>
          </label>
        </header>

        <nav
          aria-label="Hermes tabs"
          className="flex shrink-0 items-center gap-1 border-b border-border/60 px-4 pb-2"
        >
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              onClick={() => setTab(item.value)}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1.5 text-xs transition-colors",
                tab === item.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <HermesPanelScope
          value={{ environmentId, instanceId: selectedInstanceId }}
          key={`${environmentId}:${selectedInstanceId ?? "default"}`}
        >
          <ScrollArea className="min-h-0 flex-1">
            <div
              className={cn(
                "mx-auto flex w-full flex-col gap-4 px-6 py-5",
                tab === "kanban" ? "max-w-7xl" : "max-w-3xl",
              )}
            >
              {tab === "tasks" ? (
                <HermesTasksTab onNewTask={handleNewTask} target={target} />
              ) : tab === "kanban" ? (
                <HermesKanbanTab
                  {...(selectedInstanceId !== undefined ? { instanceId: selectedInstanceId } : {})}
                  environmentId={environmentId}
                />
              ) : tab === "memory" ? (
                <HermesMemoryTab />
              ) : tab === "patches" ? (
                <HermesPatchesTab />
              ) : tab === "profiles" ? (
                <HermesProfilesTab />
              ) : (
                <HermesSkillsTab key={environmentId} />
              )}
            </div>
          </ScrollArea>
        </HermesPanelScope>
      </div>
    </SidebarInset>
  );
}
