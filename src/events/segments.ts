import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { EVENT_TYPES, type EventEnvelope } from "../core/contracts";
import { HomectlError } from "../types";

// A segment is one JSONL file. Its name encodes the seq of its first event,
// so the retention window can be computed without reading every file.
export interface Segment {
  path: string;
  firstSeq: number;
}

export interface ParsedSegment {
  events: EventEnvelope[];
  // True when the file ends in a torn line (no trailing newline). The torn
  // line is dropped; `complete` holds the text without it.
  partial: boolean;
  complete: string;
}

const SEGMENT_PATTERN = /^segment-(\d{12})\.jsonl$/;

export function corruptLog(): HomectlError {
  return new HomectlError(5, "Event log is corrupt");
}

export function segmentFileName(firstSeq: number): string {
  return `segment-${String(firstSeq).padStart(12, "0")}.jsonl`;
}

export async function listSegments(directory: string): Promise<Segment[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const segments: Segment[] = [];
  for (const name of names) {
    const digits = SEGMENT_PATTERN.exec(name)?.[1];
    if (digits !== undefined)
      segments.push({ path: join(directory, name), firstSeq: Number(digits) });
  }
  return segments.sort((a, b) => a.firstSeq - b.firstSeq);
}

export function parseSegment(
  text: string,
  segment: Segment,
  origin: string,
): ParsedSegment {
  const partial = text.length > 0 && !text.endsWith("\n");
  // Splitting on "\n" leaves a final element that is either "" (complete file)
  // or the torn fragment (partial file). Both are removed here.
  const lines = text.split("\n");
  lines.pop();
  const events = lines.map((line, index) =>
    parseEnvelope(line, segment.firstSeq + index, origin),
  );
  return {
    events,
    partial,
    complete: lines.map((line) => `${line}\n`).join(""),
  };
}

function parseEnvelope(
  line: string,
  expectedSeq: number,
  origin: string,
): EventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw corruptLog();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw corruptLog();
  const record = value as Record<string, unknown>;
  const audience = record.audience;
  if (
    record.seq !== expectedSeq ||
    record.origin !== origin ||
    record.id !== `${origin}:${expectedSeq}` ||
    typeof record.type !== "string" ||
    !(EVENT_TYPES as readonly string[]).includes(record.type) ||
    typeof record.subject !== "string" ||
    typeof record.at !== "number" ||
    !Array.isArray(audience) ||
    !audience.every((entry) => typeof entry === "string") ||
    !("data" in record)
  )
    throw corruptLog();
  return record as unknown as EventEnvelope;
}
