import { describe, expect, it } from "@effect/vitest";

import { describeHermesRunDocument } from "./hermesCron.ts";

describe("describeHermesRunDocument", () => {
  it("keeps only the response of an agent run", () => {
    const document = [
      "# Cron Job: PR digest",
      "",
      "**Job ID:** 287765b4d15c",
      "**Run Time:** 2026-09-29 19:42:41",
      "**Schedule:** every 120m",
      "",
      "## Prompt",
      "",
      "[IMPORTANT: You are running as a scheduled cron job.]",
      "",
      "Summarise open PRs.",
      "",
      "## Response",
      "",
      "Two PRs need review.",
      "",
      "## Details",
      "",
      "- #12",
      "",
    ].join("\n");
    expect(describeHermesRunDocument(document)).toBe("Two PRs need review.\n\n## Details\n\n- #12");
  });

  it("skips earlier run documents pasted into the prompt", () => {
    const previous = [
      "# Cron Job: PR digest",
      "",
      "## Prompt",
      "",
      "Summarise open PRs.",
      "",
      "## Response",
      "",
      "Yesterday's digest.",
    ].join("\n");
    const document = [
      "# Cron Job: PR digest",
      "",
      "**Job ID:** job-1",
      "",
      "## Prompt",
      "",
      "## Your previous run's output",
      "Use it for continuity.",
      "",
      "```",
      previous,
      "```",
      "",
      "Summarise open PRs.",
      "",
      "## Response",
      "",
      "Today's digest.",
    ].join("\n");
    expect(describeHermesRunDocument(document)).toBe("Today's digest.");
  });

  it("explains a silent run instead of showing the control token", () => {
    const document =
      "# Cron Job: PR digest\n\n## Prompt\n\nAnything new?\n\n## Response\n\n[SILENT]\n";
    expect(describeHermesRunDocument(document)).toBe(
      "_Nothing new to report, so nothing was delivered._",
    );
  });

  it("keeps a response that quotes a result heading in a code block", () => {
    const document = [
      "# Cron Job: PR digest",
      "",
      "## Prompt",
      "",
      "Summarise open PRs.",
      "",
      "## Response",
      "",
      "Hermes run documents look like this:",
      "",
      "```markdown",
      "## Response",
      "",
      "Example.",
      "```",
      "",
      "That is the format.",
    ].join("\n");
    expect(describeHermesRunDocument(document)).toBe(
      [
        "Hermes run documents look like this:",
        "",
        "```markdown",
        "## Response",
        "",
        "Example.",
        "```",
        "",
        "That is the format.",
      ].join("\n"),
    );
  });

  it("shows no result when truncation cut the document inside a pasted earlier run", () => {
    const document = [
      "# Cron Job: PR digest",
      "",
      "## Prompt",
      "",
      "## Your previous run's output",
      "",
      "```",
      "# Cron Job: PR digest",
      "",
      "## Response",
      "",
      "Yesterday's digest.",
    ].join("\n");
    expect(describeHermesRunDocument(document, true)).toBe("");
  });

  it("does not treat a line of inline code as an opening fence", () => {
    const document = [
      "# Cron Job: PR digest",
      "",
      "## Prompt",
      "",
      "```Run `gh pr list` first.```",
      "",
      "## Response",
      "",
      "Two PRs need review.",
    ].join("\n");
    expect(describeHermesRunDocument(document, true)).toBe("Two PRs need review.");
  });

  it("keeps the error section of a failed agent run", () => {
    const document = [
      "# Cron Job: PR digest (FAILED)",
      "",
      "**Job ID:** job-1",
      "",
      "## Prompt",
      "",
      "Summarise open PRs.",
      "",
      "## Error",
      "",
      "```",
      "TimeoutError: provider timed out",
      "```",
    ].join("\n");
    expect(describeHermesRunDocument(document)).toBe(
      "## Error\n\n```\nTimeoutError: provider timed out\n```",
    );
  });

  it("keeps the status fields of a script run on separate lines", () => {
    const document = [
      "# Cron Job: voices38-watcher",
      "",
      "**Job ID:** 640d965cfffe",
      "**Run Time:** 2026-09-29 22:06:25",
      "**Mode:** no_agent (script)",
      "**Status:** silent (empty output)",
      "",
    ].join("\n");
    expect(describeHermesRunDocument(document)).toBe(
      "**Mode:** no_agent (script)  \n**Status:** silent (empty output)",
    );
  });

  it("keeps the explanation of a blocked run", () => {
    const document = [
      "# Cron Job: nightly",
      "",
      "**Job ID:** job-1",
      "**Run Time:** 2026-09-29 02:00:00",
      "**Status:** BLOCKED (configuration)",
      "",
      "Pre-dispatch validation found a configuration problem.",
    ].join("\n");
    expect(describeHermesRunDocument(document)).toBe(
      "**Status:** BLOCKED (configuration)\n\nPre-dispatch validation found a configuration problem.",
    );
  });

  it("drops a prompt that has no response after it", () => {
    const document = "# Cron Job: nightly\n\n## Prompt\n\nDo the thing.\n";
    expect(describeHermesRunDocument(document)).toBe("");
  });
});
