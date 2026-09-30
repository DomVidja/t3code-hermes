import {
  normalizeHermesMemoryEntry,
  type HermesMemoryFile,
  type HermesMemoryTarget,
} from "@t3tools/contracts";

export const HERMES_MEMORY_LABELS: Record<
  HermesMemoryTarget,
  { title: string; description: string }
> = {
  memory: {
    title: "Memory",
    description:
      "Notes Hermes keeps across conversations: useful facts, lessons, and things to remember.",
  },
  user: {
    title: "User profile",
    description:
      "What Hermes remembers about you: your preferences, habits, and how you like to work.",
  },
};

/** Python's len(str), not JavaScript's UTF-16 length. Delimiters count toward the cap. */
export function hermesMemoryChars(entries: readonly string[]): number {
  return Array.from(entries.join("\n§\n")).length;
}

export function hermesMemoryDraftUsage(
  file: HermesMemoryFile,
  oldText: string | null,
  content: string,
): number {
  const entries = [...file.entries];
  if (oldText === null) {
    if (!entries.includes(normalizeHermesMemoryEntry(content)))
      entries.push(normalizeHermesMemoryEntry(content));
  } else {
    const index = entries.indexOf(oldText);
    const next = normalizeHermesMemoryEntry(content);
    // Replacing with another existing entry collapses to it, matching the server.
    const duplicate = entries.some((entry, i) => i !== index && entry === next);
    if (index !== -1) entries.splice(index, 1, ...(duplicate ? [] : [next]));
  }
  return hermesMemoryChars(entries);
}

export function describeHermesMemoryUsage(file: HermesMemoryFile): string {
  return `${file.charsUsed.toLocaleString()} of ${file.charLimit.toLocaleString()} characters`;
}

export { normalizeHermesMemoryEntry };
