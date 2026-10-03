import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  HermesProfileConfigureInput,
  HermesProfileCreateInput,
  HermesProfileLinkInput,
} from "./hermesProfiles.ts";

const decodeCreate = Schema.decodeUnknownSync(HermesProfileCreateInput);
const decodeConfigure = Schema.decodeUnknownSync(HermesProfileConfigureInput);
const decodeLink = Schema.decodeUnknownSync(HermesProfileLinkInput);

describe("Hermes profile inputs", () => {
  it("rejects profile traversal and oversized arguments before invoking the CLI", () => {
    for (const name of ["../default", "--clone", "/tmp/profile", "name\nother"])
      expect(() => decodeCreate({ name })).toThrow();
    expect(() =>
      decodeConfigure({
        name: "research",
        model: "x".repeat(513),
      }),
    ).toThrow();
    expect(() =>
      decodeLink({
        name: "research",
        newInstanceId: "../other",
        displayName: "Research",
      }),
    ).toThrow();
    expect(
      decodeConfigure({
        name: "research",
        toolsets: "",
        reasoningEffort: "",
      }),
    ).toMatchObject({ toolsets: "", reasoningEffort: "" });
  });
});
