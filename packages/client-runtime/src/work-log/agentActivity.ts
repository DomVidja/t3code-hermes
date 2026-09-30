/**
 * Recognizes skill and memory tool calls from the titles Hermes gives them
 * (`skill view (name)`, `memory add: user`, `hindsight_recall: query`, ...).
 * The canonical activity title flattens these into "Read file" or "Changed
 * files", so the provider's own title is the only place the identity survives.
 */

export type AgentActivityKind = "skill" | "memory";

export type AgentActivity =
  | { readonly kind: "skill"; readonly action: "view"; readonly name: string }
  | { readonly kind: "skill"; readonly action: "view-file"; readonly name: string }
  | { readonly kind: "skill"; readonly action: "list"; readonly name?: string }
  | {
      readonly kind: "skill";
      readonly action: "create" | "update" | "delete" | "add-file" | "remove-file" | "change";
      readonly name: string;
    }
  | {
      readonly kind: "memory";
      readonly action: "save" | "update" | "remove";
      readonly target: "memory" | "user";
    }
  | { readonly kind: "memory"; readonly action: "recall" | "reflect"; readonly query?: string }
  | { readonly kind: "memory"; readonly action: "retain" }
  | { readonly kind: "memory"; readonly action: "search-sessions"; readonly query: string }
  | { readonly kind: "memory"; readonly action: "recent-sessions" };

export interface AgentActivityRowOptions {
  readonly skills: boolean;
  readonly memory: boolean;
}

const SKILL_MANAGE_ACTIONS: Readonly<Record<string, AgentActivity["action"]>> = {
  create: "create",
  patch: "update",
  edit: "update",
  delete: "delete",
  write_file: "add-file",
  remove_file: "remove-file",
  manage: "change",
};

const MEMORY_ACTIONS: Readonly<Record<string, "save" | "update" | "remove">> = {
  add: "save",
  replace: "update",
  remove: "remove",
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function classifyAgentActivity(title: string | undefined): AgentActivity | null {
  const value = nonEmpty(title);
  if (!value) return null;

  const skillView = /^skill[ _]view(?:\s*\((.+)\)|:\s*(.+))?$/i.exec(value);
  if (skillView) {
    const target = nonEmpty(skillView[1] ?? skillView[2]);
    if (!target) return null;
    return target.includes("/")
      ? { kind: "skill", action: "view-file", name: target }
      : { kind: "skill", action: "view", name: target };
  }

  const skillsList = /^skills[ _]list(?:\s*\((.+)\))?$/i.exec(value);
  if (skillsList) {
    const category = nonEmpty(skillsList[1]);
    return category
      ? { kind: "skill", action: "list", name: category }
      : { kind: "skill", action: "list" };
  }

  const skillManage =
    /^skill (create|patch|edit|delete|write_file|remove_file|manage): (.+)$/i.exec(value);
  if (skillManage) {
    const action = SKILL_MANAGE_ACTIONS[skillManage[1]!.toLowerCase()] ?? "change";
    return {
      kind: "skill",
      action: action as "create" | "update" | "delete" | "add-file" | "remove-file" | "change",
      name: skillManage[2]!.trim(),
    };
  }

  const memory = /^memory (add|replace|remove): (memory|user)$/i.exec(value);
  if (memory) {
    return {
      kind: "memory",
      action: MEMORY_ACTIONS[memory[1]!.toLowerCase()]!,
      target: memory[2]!.toLowerCase() as "memory" | "user",
    };
  }

  // Hermes' own Hindsight tools, or the same tools reached through an MCP server.
  const hindsight = /^(?:mcp_[a-z0-9-]+_)?hindsight_(recall|retain|reflect)(?::\s*(.*))?$/i.exec(
    value,
  );
  if (hindsight) {
    const action = hindsight[1]!.toLowerCase();
    if (action === "retain") return { kind: "memory", action: "retain" };
    const query = nonEmpty(hindsight[2]);
    return {
      kind: "memory",
      action: action as "recall" | "reflect",
      ...(query ? { query } : {}),
    };
  }

  const sessionSearch = /^session search: (.+)$/i.exec(value);
  if (sessionSearch) {
    return { kind: "memory", action: "search-sessions", query: sessionSearch[1]!.trim() };
  }
  if (/^recent sessions$/i.test(value)) {
    return { kind: "memory", action: "recent-sessions" };
  }

  return null;
}

/** The provider's own tool title, which the canonical activity title may have replaced. */
export function extractProviderToolTitle(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const data = (payload as { readonly data?: unknown }).data;
  if (data === null || typeof data !== "object") return undefined;
  const title = (data as { readonly title?: unknown }).title;
  return typeof title === "string" ? nonEmpty(title) : undefined;
}

/**
 * Attaches skill and memory identity to work-log entries the user opted into.
 * Entries that do not match, or whose kind is switched off, keep their identity
 * so memoized rows downstream do not re-render.
 */
export function annotateAgentActivity<
  T extends { readonly providerToolTitle?: string; readonly toolTitle?: string },
>(
  entries: ReadonlyArray<T>,
  options: AgentActivityRowOptions | undefined,
): Array<T & { readonly agentActivity?: AgentActivity }> {
  if (!options || (!options.skills && !options.memory)) return entries as T[];
  return entries.map((entry) => {
    const agentActivity = classifyAgentActivity(entry.providerToolTitle ?? entry.toolTitle);
    if (!agentActivity) return entry;
    if (agentActivity.kind === "skill" ? !options.skills : !options.memory) return entry;
    return { ...entry, agentActivity };
  });
}

type Verbs = readonly [action: string, running: string, completed: string];

function describe(activity: AgentActivity): { readonly verbs: Verbs; readonly target: string } {
  if (activity.kind === "skill") {
    switch (activity.action) {
      case "view":
        return { verbs: ["Load", "Loading", "Loaded"], target: `skill ${activity.name}` };
      case "view-file":
        return { verbs: ["Read", "Reading", "Read"], target: `skill file ${activity.name}` };
      case "list":
        return {
          verbs: ["List", "Listing", "Listed"],
          target: activity.name ? `skills in ${activity.name}` : "skills",
        };
      case "create":
        return { verbs: ["Create", "Creating", "Created"], target: `skill ${activity.name}` };
      case "update":
        return { verbs: ["Update", "Updating", "Updated"], target: `skill ${activity.name}` };
      case "delete":
        return { verbs: ["Delete", "Deleting", "Deleted"], target: `skill ${activity.name}` };
      case "add-file":
        return { verbs: ["Add", "Adding", "Added"], target: `a file to skill ${activity.name}` };
      case "remove-file":
        return {
          verbs: ["Remove", "Removing", "Removed"],
          target: `a file from skill ${activity.name}`,
        };
      case "change":
        return { verbs: ["Change", "Changing", "Changed"], target: `skill ${activity.name}` };
    }
  }
  switch (activity.action) {
    case "save":
      return {
        verbs: ["Save", "Saving", "Saved"],
        target: activity.target === "user" ? "to the user profile" : "to memory",
      };
    case "update":
      return {
        verbs: ["Update", "Updating", "Updated"],
        target: activity.target === "user" ? "the user profile" : "memory",
      };
    case "remove":
      return {
        verbs: ["Remove", "Removing", "Removed"],
        target: activity.target === "user" ? "from the user profile" : "from memory",
      };
    case "recall":
      return {
        verbs: ["Recall", "Recalling", "Recalled"],
        target: activity.query ? `memories: ${activity.query}` : "memories",
      };
    case "reflect":
      return {
        verbs: ["Reflect", "Reflecting", "Reflected"],
        target: activity.query ? `on memories: ${activity.query}` : "on memories",
      };
    case "retain":
      return { verbs: ["Save", "Saving", "Saved"], target: "a long-term memory" };
    case "search-sessions":
      return {
        verbs: ["Search", "Searching", "Searched"],
        target: `past sessions: ${activity.query}`,
      };
    case "recent-sessions":
      return { verbs: ["Browse", "Browsing", "Browsed"], target: "recent sessions" };
  }
}

export function agentActivityDisplayName(activity: AgentActivity, status: string | undefined) {
  const {
    verbs: [action, running, completed],
    target,
  } = describe(activity);
  const verb =
    status === "completed"
      ? completed
      : status === "failed"
        ? `Failed to ${action.toLowerCase()}`
        : status === "declined"
          ? `Declined to ${action.toLowerCase()}`
          : status === "stopped"
            ? `Stopped ${running.toLowerCase()}`
            : running;
  return `${verb} ${target}`;
}
