import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { HermesMemoryMutateInput, HermesMemorySnapshot } from "./hermesMemory.ts";

const decodeMutation = Schema.decodeUnknownSync(HermesMemoryMutateInput);
const decodeSnapshot = Schema.decodeUnknownSync(HermesMemorySnapshot);
const encodeSnapshot = Schema.encodeSync(HermesMemorySnapshot);

describe("native Hermes memory wire contract", () => {
  it("round-trips healthy and read-only files without dropping notes", () => {
    const snapshot: HermesMemorySnapshot = {
      availability: "ready",
      detail: null,
      files: [
        {
          target: "memory",
          entries: ["Multiline\nnote", "Uses § in prose"],
          charsUsed: 33,
          charLimit: 2200,
          revision: "revision",
          error: null,
        },
        {
          target: "user",
          entries: ["Preserved, non-roundtripping content"],
          charsUsed: 34,
          charLimit: 1375,
          revision: "other",
          error: "Read only",
        },
      ],
    };
    expect(decodeSnapshot(encodeSnapshot(snapshot))).toEqual(snapshot);
  });
  it("requires an exact old entry and revision for replacement/removal", () => {
    expect(() => decodeMutation({ target: "user", action: "remove", revision: "hash" })).toThrow();
    expect(() => decodeMutation({ target: "memory", action: "add", content: "note" })).toThrow();
    expect(() =>
      decodeMutation({
        target: "../../config.yaml",
        action: "add",
        content: "note",
        revision: "hash",
      }),
    ).toThrow();
    expect(
      decodeMutation({
        target: "user",
        action: "replace",
        oldText: "before",
        content: "after",
        revision: "hash",
      }),
    ).toMatchObject({ action: "replace", oldText: "before" });
  });
});
