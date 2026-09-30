import { describe, expect, it } from "vite-plus/test";

import { validateHermesSearch } from "./hermesNavigation";

describe("Hermes run deep links", () => {
  it("retains the owning environment instead of choosing the automatic host", () => {
    expect(
      validateHermesSearch({ environmentId: " remote ", jobId: " job ", runId: " run " }),
    ).toEqual({
      environmentId: "remote",
      jobId: "job",
      runId: "run",
    });
  });

  it.each([undefined, null, 5, [], {}, "  "])(
    "rejects an invalid environment %s",
    (environmentId) => {
      expect(validateHermesSearch({ environmentId, jobId: "job", runId: "run" })).toEqual({});
    },
  );

  it("does not associate orphan runs with another task", () => {
    expect(validateHermesSearch({ environmentId: "remote", jobId: [], runId: "run" })).toEqual({
      environmentId: "remote",
    });
    expect(validateHermesSearch({ environmentId: "remote", jobId: "job", runId: 123 })).toEqual({
      environmentId: "remote",
      jobId: "job",
    });
  });
});
