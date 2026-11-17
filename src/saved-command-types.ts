export const SAVED_COMMAND_VERSION = 1 as const;

export type SavedCommandParameter = {
  name: string;
  description?: string;
};

export type SavedCommand = {
  schemaVersion: typeof SAVED_COMMAND_VERSION;
  id: string;
  name: string;
  hosts: string[];
  argv: string[];
  parameters: SavedCommandParameter[];
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type SavedCommandInput = Omit<
  SavedCommand,
  "schemaVersion" | "id" | "createdAt" | "updatedAt" | "parameters"
> & { parameters?: SavedCommandParameter[] };

export type SavedCommandIssue = {
  id: string;
  status: "invalid";
  reason: string;
};

export type SavedCommandRecordIssue = { id: string; reason: string };
