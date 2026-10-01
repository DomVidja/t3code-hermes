const assert = require("node:assert/strict");
const test = require("node:test");
const { formatReleaseNotes, parseForkChanges } = require("./fork-release-notes.cjs");

const commit = (parents, subject, body = "") => `${parents}\x1f${subject}\x1f${body}\x1e`;

test("fork changes keep PR titles and direct commits, and drop sync merges", () => {
  const log = [
    commit("a", "fix(server): recover stale provider sessions (#2)"),
    commit(
      "b c",
      "Merge pull request #91 from NateWeav/feat/x",
      "\nfeat(web): add a Hermes thing\n",
    ),
    commit("d e", "Merge remote-tracking branch 'upstream/main'"),
    commit(
      "f g",
      "Merge pull request #90 from NateWeav/hermes/upstream-sync",
      "chore(sync): merge upstream",
    ),
    commit("h", "ci: run fork workflows on hosted runners"),
  ].join("\n");

  assert.deepEqual(parseForkChanges(log), [
    "fix(server): recover stale provider sessions (#2)",
    "feat(web): add a Hermes thing (#91)",
    "ci: run fork workflows on hosted runners",
  ]);
});

test("notes list upstream changes before fork changes and link upstream PRs", () => {
  const notes = formatReleaseNotes({
    upstreamSubjects: ["feat: start threads without a project (#13612)"],
    forkChanges: ["feat(web): add a Hermes thing (#91)"],
    upstreamRepo: "pingdotgg/t3code",
    compareUrl: "https://github.com/fork/t3code/compare/a...b",
  });

  assert.equal(
    notes,
    [
      "## Upstream changes (pingdotgg/t3code)",
      "",
      "- feat: start threads without a project ([#13612](https://github.com/pingdotgg/t3code/pull/13612))",
      "",
      "## Fork changes",
      "",
      "- feat(web): add a Hermes thing (#91)",
      "",
      "**Full Changelog**: https://github.com/fork/t3code/compare/a...b",
      "",
    ].join("\n"),
  );
});

test("empty sections are omitted", () => {
  const notes = formatReleaseNotes({
    upstreamSubjects: [],
    forkChanges: [],
    upstreamRepo: "pingdotgg/t3code",
    compareUrl: "https://github.com/fork/t3code/compare/a...b",
  });

  assert.equal(notes, "**Full Changelog**: https://github.com/fork/t3code/compare/a...b\n");
});
