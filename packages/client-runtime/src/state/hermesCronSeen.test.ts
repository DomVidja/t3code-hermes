import { describe, expect, it } from "@effect/vitest";

import {
  hasUnseenHermesCompletions,
  markHermesTasksSeen,
  reportHermesCompletion,
} from "./hermesCronSeen.ts";

describe("hermesCronSeen", () => {
  it("lights again for a run after the panel was opened", () => {
    const environmentId = "reconnect";
    reportHermesCompletion(environmentId);
    markHermesTasksSeen(environmentId);
    expect(hasUnseenHermesCompletions(environmentId)).toBe(false);

    // A reconnected subscription restarts its own counter; the store must not care.
    reportHermesCompletion(environmentId);
    expect(hasUnseenHermesCompletions(environmentId)).toBe(true);
  });

  it("keeps environments apart", () => {
    reportHermesCompletion("remote");
    expect(hasUnseenHermesCompletions("remote")).toBe(true);
    expect(hasUnseenHermesCompletions("local")).toBe(false);
  });
});
