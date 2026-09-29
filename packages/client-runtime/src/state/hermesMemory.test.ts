import type { HermesMemoryFile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hermesMemoryChars, hermesMemoryDraftUsage } from "./hermesMemory.ts";

const file: HermesMemoryFile = {
  target: "memory",
  entries: ["🙂", "B"],
  charsUsed: 5,
  charLimit: 8,
  revision: "hash",
  error: null,
};

describe("Hermes memory draft usage", () => {
  it("matches Python character counts, including separators but not UTF-16 surrogates", () => {
    expect(hermesMemoryChars(file.entries)).toBe(5);
    expect(hermesMemoryDraftUsage(file, null, " C ")).toBe(9);
    expect(hermesMemoryDraftUsage(file, "B", "𐐀 longer")).toBe(12);
  });
  it("does not count an idempotent duplicate add as consuming capacity", () => {
    expect(hermesMemoryDraftUsage(file, null, "🙂")).toBe(5);
  });
  it("previews normalized pasted newlines and Python whitespace without stripping BOM content", () => {
    expect(hermesMemoryDraftUsage(file, "B", "\u0085A\r\nB\u0085")).toBe(7);
    expect(hermesMemoryDraftUsage(file, "B", "\ufeffB")).toBe(6);
  });
  it("does not mutate live entries while previewing an edit", () => {
    expect(hermesMemoryDraftUsage(file, "B", "New")).toBe(7);
    expect(file.entries).toEqual(["🙂", "B"]);
  });
});
