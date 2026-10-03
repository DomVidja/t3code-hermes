import {
  HermesProfilesError,
  ProviderInstanceId,
  type HermesProfile,
  type HermesProfileConfigureInput,
} from "@t3tools/contracts";
import { Cause, Schema } from "effect";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useHermesPanelScope } from "../../state/hermesInstanceScope";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const isProfilesError = Schema.is(HermesProfilesError);

type Draft = { model: string; provider: string; reasoning: string; toolsets: string };
const draftFor = (profile: HermesProfile): Draft => ({
  model: profile.model.default,
  provider: profile.model.provider,
  reasoning: profile.reasoning_effort,
  toolsets: profile.platform_toolsets.acp?.join(",") ?? "",
});

function ProfileEditor({
  profile,
  onSave,
  onLink,
  pending,
}: {
  profile: HermesProfile;
  onSave: (draft: Draft) => void;
  onLink: () => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState(() => draftFor(profile));
  const changed = JSON.stringify(draft) !== JSON.stringify(draftFor(profile));
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/60 p-4">
      <h3 className="text-sm font-semibold">{profile.display_name || profile.name}</h3>
      <p className="text-xs text-muted-foreground">
        Changes apply to new Hermes sessions. Authentication stays with Hermes.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Model
          <Input
            aria-label="Profile model"
            value={draft.model}
            disabled={pending}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Provider
          <Input
            aria-label="Profile provider"
            value={draft.provider}
            disabled={pending}
            onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Reasoning effort
          <select
            aria-label="Profile reasoning effort"
            className="rounded-md border border-border bg-background px-2 py-1"
            value={draft.reasoning}
            disabled={pending}
            onChange={(event) => setDraft({ ...draft, reasoning: event.target.value })}
          >
            {["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
              (effort) => (
                <option value={effort} key={effort}>
                  {effort || "Provider default"}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          ACP toolsets
          <Input
            aria-label="Profile ACP toolsets"
            value={draft.toolsets}
            disabled={pending}
            onChange={(event) => setDraft({ ...draft, toolsets: event.target.value })}
          />
          <span className="text-xs text-muted-foreground">
            Comma-separated toolset names. Leave empty to use Hermes's defaults.
          </span>
        </label>
        <div className="flex gap-2">
          <Button size="sm" type="submit" disabled={pending || !changed}>
            Save profile
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={onLink}>
            Enable as a T3 provider
          </Button>
        </div>
      </form>
    </section>
  );
}

export function HermesProfilesTab() {
  const scope = useHermesPanelScope();
  const environmentId = scope?.environmentId ?? null;
  const input = scope?.instanceId === undefined ? {} : { instanceId: scope.instanceId };
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<HermesProfileConfigureInput | null>(null);
  const list = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesProfilesList({ environmentId, input }),
  );
  const detail = useEnvironmentQuery(
    environmentId === null || selected === null
      ? null
      : serverEnvironment.hermesProfilesShow({
          environmentId,
          input: { ...input, name: selected },
        }),
  );
  const create = useAtomCommand(serverEnvironment.hermesProfilesCreate, { reportFailure: false });
  const configure = useAtomCommand(serverEnvironment.hermesProfilesConfigure, {
    reportFailure: false,
  });
  const link = useAtomCommand(serverEnvironment.hermesProfilesLink, { reportFailure: false });
  const failure = (cause: Cause.Cause<unknown>, request?: HermesProfileConfigureInput) => {
    const value = Cause.squash(cause);
    setError(value instanceof Error ? value.message : "The Hermes profile request failed.");
    if (request !== undefined && isProfilesError(value) && value.code === "confirmation_required")
      setConfirmation(request);
  };
  const save = async (request: HermesProfileConfigureInput) => {
    if (pending || environmentId === null) return;
    setPending(true);
    setError(null);
    setNotice(null);
    setConfirmation(null);
    try {
      const result = await configure({ environmentId, input: request });
      if (result._tag !== "Success") {
        failure(result.cause, request);
        return;
      }
      detail.refresh();
      list.refresh();
      setNotice("Profile saved. Start a new session to use these settings.");
    } finally {
      setPending(false);
    }
  };
  const createProfile = async () => {
    if (pending || environmentId === null || !name.trim()) return;
    setPending(true);
    setError(null);
    setNotice(null);
    setConfirmation(null);
    try {
      const result = await create({
        environmentId,
        input: { ...input, name: name.trim(), description },
      });
      if (result._tag !== "Success") {
        failure(result.cause);
        return;
      }
      setSelected(result.value.name);
      setName("");
      setDescription("");
      list.refresh();
      setNotice("Fresh profile created. Configure its model and enable it in T3 when ready.");
    } finally {
      setPending(false);
    }
  };
  const linkProfile = async () => {
    if (pending || environmentId === null || detail.data === null) return;
    setPending(true);
    setError(null);
    setNotice(null);
    setConfirmation(null);
    try {
      const result = await link({
        environmentId,
        input: {
          ...input,
          name: detail.data.name,
          newInstanceId: ProviderInstanceId.make(`hermes_profile_${randomUUID()}`),
          displayName: detail.data.display_name || detail.data.name,
        },
      });
      if (result._tag !== "Success") {
        failure(result.cause);
        return;
      }
      setNotice(
        "Profile enabled as a T3 provider. Choose it in the model picker or Hermes profile selector.",
      );
    } finally {
      setPending(false);
    }
  };
  if (environmentId === null) return <p>Enable a Hermes provider to manage profiles.</p>;
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold">Hermes profiles</h2>
      <p className="text-xs text-muted-foreground">
        Each profile owns its model settings, memory and skills. Fresh profiles do not copy
        credentials.
      </p>
      {list.isPending && list.data === null ? <p role="status">Loading profiles…</p> : null}
      {list.error !== null ? (
        <div role="alert">
          <p>{list.error}</p>
          <Button size="sm" variant="ghost" onClick={list.refresh}>
            Retry profiles
          </Button>
        </div>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        Existing profile
        <select
          aria-label="Existing Hermes profile"
          className="rounded-md border border-border bg-background px-2 py-1"
          value={selected ?? ""}
          disabled={pending}
          onChange={(event) => {
            setSelected(event.target.value || null);
            setError(null);
            setNotice(null);
            setConfirmation(null);
          }}
        >
          <option value="">Choose a profile</option>
          {list.data?.profiles.map((profile) => (
            <option key={profile.name} value={profile.name}>
              {profile.display_name || profile.name}
              {profile.is_default ? " (default)" : ""} · {profile.model || "Model not configured"} ·{" "}
              {profile.skill_count} skills
            </option>
          ))}
        </select>
      </label>
      {detail.error !== null ? (
        <div role="alert">
          <p>{detail.error}</p>
          <Button size="sm" variant="ghost" onClick={detail.refresh}>
            Retry profile
          </Button>
        </div>
      ) : null}
      {detail.data !== null ? (
        <ProfileEditor
          key={JSON.stringify(detail.data)}
          profile={detail.data}
          pending={pending}
          onLink={() => void linkProfile()}
          onSave={(draft) => {
            const before = draftFor(detail.data!);
            void save({
              ...input,
              name: detail.data!.name,
              ...(draft.model === before.model && draft.provider === before.provider
                ? {}
                : { model: draft.model, provider: draft.provider }),
              ...(draft.reasoning === before.reasoning
                ? {}
                : {
                    reasoningEffort: draft.reasoning as NonNullable<
                      HermesProfileConfigureInput["reasoningEffort"]
                    >,
                  }),
              ...(draft.toolsets === before.toolsets ? {} : { toolsets: draft.toolsets }),
            });
          }}
        />
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {confirmation !== null ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() => void save({ ...confirmation, confirmExpensiveModel: true })}
          >
            Approve {confirmation.provider}/{confirmation.model} and save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmation(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {notice !== null ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-3 rounded-lg border border-border/60 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void createProfile();
        }}
      >
        <h3 className="text-sm font-semibold">Create a fresh profile</h3>
        <label className="flex flex-col gap-1 text-sm">
          Name
          <Input
            aria-label="New profile name"
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
            placeholder="research"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Description
          <Input
            aria-label="New profile description"
            value={description}
            disabled={pending}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div>
          <Button type="submit" size="sm" disabled={pending || !name.trim()}>
            Create profile
          </Button>
        </div>
      </form>
    </div>
  );
}
