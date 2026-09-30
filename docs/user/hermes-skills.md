# Browse what Hermes has learned

Hermes saves reusable procedures as skills and improves them as it works. Open the clock button in
web or desktop's sidebar, then **Skills**. On mobile, open **Settings → Hermes → Skills** and choose
the environment that runs Hermes.

Search by name, description, category, or tag, or filter by origin. **Recently changed by Hermes**
shows the latest agent and curator edits recorded by Hermes. Open a skill to read its instructions
and see the names of supporting files. Contents load only when you open a skill; the list updates
while the tab is open.

**Bundled** skills ship with Hermes. **Hermes-created** means Hermes's audit history records an agent
or curator creating the skill. **User** means neither source establishes that origin; an older or
imported skill can appear here even if an agent originally wrote it. A skill Hermes later improves
keeps its original badge. Usage counts come from Hermes's own usage records.

Create, improve, or remove skills by asking Hermes in chat, or use the Hermes CLI. The Skills tab is
read-only and does not change the skill library. Archived skills are not listed.

## When skills are missing

Skills belong to the selected environment, not the device you are viewing them on. The panel uses
the same enabled Hermes instance as Tasks, including its `HERMES_HOME` override. When that instance
has no skills directory, is disabled, or its files cannot be read, the panel explains why instead of
showing an unexplained empty list. Partial or oversized libraries carry a notice; use **Refresh**
after fixing the files. Without Hermes's audit ledger, there is no learning history to display.
