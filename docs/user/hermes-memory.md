# Browse what the agent remembers

The Memory tab shows the notes Hermes keeps across conversations, whether or not you use an
external memory service. On web and desktop, open the Hermes panel from the sidebar and select
**Memory**. On mobile, open **Settings → Hermes → Memory**. Enable the Hermes provider in the
environment's Settings if it is not available.

## Hermes memory

**Memory** contains the agent's notes. **User profile** contains what it remembers about you.
These are Hermes's own `memories/MEMORY.md` and `memories/USER.md` files, not a second copy.
The tab follows the enabled Hermes instance's home directory and updates when Hermes changes them.
On Windows, set the provider instance's `HERMES_HOME` environment variable to Hermes's data directory.

Add a note, edit an entry, or remove one after confirming. Each file shows its character usage;
shorten or remove stale entries when it reaches its limit. If Hermes changes the file while you
are editing, review the latest entries before trying again. Files that cannot be read safely stay
read-only rather than being overwritten. Saving requires Python 3 on the server (normally supplied
by the Hermes installation).

Hermes captures its memory for a conversation when that conversation starts. A saved change is
visible here immediately, but an already-running conversation may still use its original snapshot.

## Hindsight (optional)

[Hindsight] is an additional memory service for recall, browsing by pathway, and reflection. Its
section remains separate from Hermes's built-in notes; neither service copies entries into the other.

[Hindsight]: https://github.com/vectorize-io/hindsight

### Setting up Hindsight

If Hermes already uses Hindsight for its memory, there is nothing to do: the Memory tab reads
Hermes' own Hindsight config and opens on the same bank. That is the file Hermes' `hermes memory
setup` writes, `~/.hermes/hindsight/config.json` (or `$HERMES_HOME/hindsight/config.json`).

To point Memory somewhere else, open **Settings → Integrations → Memory** on web and desktop, or
**Settings → Environments →** your environment **→ Memory** on mobile. The connection line there
says whether Hindsight is answering and whether the address came from Hermes or from these
settings. Each field you fill in (server URL, default bank, API key) replaces that one value from
Hermes; clearing it goes back to Hermes'. Changes apply on the next read, with no restart.

Only the T3 Code server ever talks to Hindsight, so a loopback or tailnet address keeps working
from your phone, from app.t3.codes, or through a tunnel, and the API key never leaves the server.
Hermes' key is only ever sent to Hermes' own Hindsight address, never to one you typed in Settings.

Switch Memory off in the same place to stop the environment from contacting Hindsight at all.
Without Hindsight configured, you can still browse and edit Hermes memory above it.

## Recalling and browsing

A line above the search box sizes up the bank you are looking at: how many memories and links it
holds, how many documents they came from, how those memories split across the pathways, and when
Hindsight last consolidated. Work that is queued or that failed is mentioned only when there is
some. While the counts are still being read the line says so rather than showing zeroes, and if
Hindsight cannot produce them the line simply goes away — the memories below it are unaffected.

With no search typed, the tab shows the most recent memories, newest first. Type a question and
press Enter to recall instead: Hindsight searches by meaning rather than by keyword, and each
result shows how strong a match it was.

Four filters narrow the list:

- **All** — everything, including standing conclusions.
- **World** — facts about how things are.
- **Experiences** — things that happened.
- **Mental models** — the summaries Hindsight maintains for itself by reflecting over a bank.

If Hindsight holds more than one bank, a picker appears next to the filters. Memories are scoped to
one bank at a time, so switching banks switches the whole view.

Mental models are stored differently from ordinary memories, and Hindsight offers no meaning-based
search over them. A typed query matches them on their text instead, so they appear after the ranked
results rather than mixed in among them.

## Retaining a note and reflecting

Two actions sit at the bottom of the tab.

**Retain a note…** opens a single line. Whatever you write goes to Hindsight, which pulls the facts
out of it and files them; the confirmation tells you how many it found. This waits for Hindsight to
finish rather than reporting success and hoping, so a note that says it saved really did.

**Reflect now** asks Hindsight to reason over the whole bank and answer in prose. With a search
typed, it reflects on that question; with the search box empty, it summarises what the bank knows
and what it is least sure of. The answer appears above the list until you dismiss it. Reflection
runs a language model, so it takes longer than a search.

Editing and deleting Hindsight memories still use Hindsight's own tools. The add, edit, and remove
actions in **Hermes memory** affect only Hermes's built-in files.

## When something is wrong

The tab distinguishes between the reasons it has nothing to show, because each one has a different
fix:

- **Not set up** — neither Hermes nor Settings names a Hindsight server for this environment, or
  Memory is switched off. The tab links to the Memory settings.
- **Not answering** — Hindsight is configured but nothing is listening. Start it and press **Try
  again**; nothing needs restarting on the T3 Code side.
- **A version T3 Code does not understand** — Hindsight answered, but in a shape this build does not
  recognise. This means one of the two needs updating, and it is reported once at the top of the tab
  rather than as a failure on everything you click.
- **Empty bank** — Hindsight is working and this bank genuinely holds nothing yet.

If a request fails after the panel has loaded, the affected action reports **Request failed**. If a
response cannot be decoded, it reports **Could not be read**. Retry the action; the rest of the panel
remains available.
