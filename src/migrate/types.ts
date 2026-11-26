// Shared types for the workspace migration (homelab #21 §3). Kept apart from
// index.ts so the step modules do not import the engine that imports them.

export interface MigrationContext {
  // The directory holding the inventory. Everything 0.2 wrote lives here.
  workspace: string;
  inventoryPath: string;
  // Where the 0.3 broker keeps its state (clients.json and friends). Compat
  // mode: <workspace>/broker. Hardened mode passes the service state directory.
  brokerState: string;
  now: number;
  // Free-form notes for the owner. Never secret values, tokens or key material.
  note(message: string): void;
}

export interface MigrationStep {
  id: string;
  from: number;
  to: number;
  description: string;
  // Absolute paths the step may create, change or delete. The engine backs
  // them up before the first step runs and checks that nothing else changed.
  touches(context: MigrationContext): string[] | Promise<string[]>;
  run(context: MigrationContext): Promise<void>;
  // Must throw when the result is not in place. Runs right after `run`.
  verify(context: MigrationContext): Promise<void>;
}

export interface PlannedStep {
  id: string;
  description: string;
  // Display names: workspace-relative, or broker-state/<name> outside it.
  touches: string[];
}

export interface MarkerHistory {
  from: number;
  to: number;
  at: string;
  backup: string;
  steps: string[];
}

export interface Marker {
  data_version: number;
  history: MarkerHistory[];
}

export type MigrationResult =
  | { status: "current"; version: number }
  | { status: "initialized"; version: number }
  | { status: "planned"; from: number; to: number; steps: PlannedStep[] }
  | {
      status: "migrated";
      from: number;
      to: number;
      backup: string;
      steps: string[];
      notes: string[];
    };
