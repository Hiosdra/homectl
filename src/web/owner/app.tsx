// Owner panel entry point. One session gate, one live-updated data set, and
// hash routes (no secrets or tokens in the URL). Everything the owner decides
// goes to the broker through the same-origin proxy.
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentsScreen } from "./agents";
import {
  describeError,
  type PendingOperation,
  type PendingSecret,
  OwnerApiError,
  ownerCall,
} from "./api";
import {
  AlertTracker,
  alertPermission,
  approvalAlert,
  secretAlert,
  showAlert,
  workspaceApprovalAlert,
} from "./alerts";
import { ApprovalScreen } from "./approval";
import { useOwnerLive } from "./live";
import { OverviewScreen } from "./overview";
import { PolicyScreen } from "./policy";
import { type Route, parseRoute } from "./route";
import { SecretScreen } from "./secret";
import { SignInScreen } from "./signin";
import { SystemScreen } from "./system";
import { Badge, Notice } from "./ui";
import {
  listWorkspaceClients,
  listWorkspaceIntents,
  listWorkspacePending,
  probeWorkspace,
  type WorkspaceClient,
  type WorkspaceIntentRow,
  type WorkspacePending,
  type WorkspaceServerInfo,
} from "./workspace-api";
import { WorkspaceScreen } from "./workspace";

type Session =
  | { state: "checking" }
  | { state: "signed-out"; notice?: string }
  | { state: "signed-in"; expiresAt?: number }
  | { state: "offline"; message: string };

interface Data {
  operations: PendingOperation[];
  secrets: PendingSecret[];
  // Present only when this broker is a workspace server.
  workspace?: {
    clients: WorkspaceClient[];
    pending: WorkspacePending[];
    intents: WorkspaceIntentRow[];
  };
  loadedAt: number;
}

const SIGNED_OUT_NOTICE = "Your owner session ended. Sign in again.";
// Linked clients reach the server by sync, not by this broker's stream, so the
// workspace is re-read on a timer while the panel is open.
const WORKSPACE_POLL_MS = 10_000;

async function readWorkspace(): Promise<Data["workspace"]> {
  const [clients, pending, intents] = await Promise.all([
    listWorkspaceClients(),
    listWorkspacePending(),
    listWorkspaceIntents(),
  ]);
  return { clients, pending, intents };
}

function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return [route, (hash) => (location.hash = hash)];
}

const NAV: { label: string; hash: string; name: Route["name"] }[] = [
  { label: "Needs you", hash: "#/", name: "overview" },
  { label: "Agents", hash: "#/agents", name: "agents" },
  { label: "Permissions", hash: "#/policy", name: "policy" },
];

function App() {
  const [session, setSession] = useState<Session>({ state: "checking" });
  const [data, setData] = useState<Data>({
    operations: [],
    secrets: [],
    loadedAt: 0,
  });
  // undefined: not asked yet. null: this broker is not a workspace server.
  const [server, setServer] = useState<
    WorkspaceServerInfo | null | undefined
  >();
  // One tracker per panel session: each new request alerts once.
  const [alerts] = useState(
    () => new AlertTracker(showAlert, () => alertPermission() === "granted"),
  );
  const [route, go] = useRoute();
  const [flash, setFlash] = useState<string | undefined>();
  const signedIn = session.state === "signed-in";

  // A notice explains a sign-out only when a session was actually running.
  const signOut = useCallback(
    (notice?: string) => {
      setSession((previous) => ({
        state: "signed-out",
        ...(notice && previous.state === "signed-in" ? { notice } : {}),
      }));
      setData({ operations: [], secrets: [], loadedAt: 0 });
      setServer(undefined);
      alerts.reset();
    },
    [alerts],
  );

  const handle = useCallback(
    (error: unknown) => {
      if (error instanceof OwnerApiError && error.signedOut)
        return signOut(SIGNED_OUT_NOTICE);
      if (error instanceof OwnerApiError && error.brokerOffline)
        setSession({ state: "offline", message: describeError(error) });
      return undefined;
    },
    [signOut],
  );

  const refresh = useCallback(async () => {
    try {
      // A failed workspace read does not hide local approvals: the last
      // workspace data stays on screen until the next read succeeds.
      const [operations, secrets, workspace] = await Promise.all([
        ownerCall<PendingOperation[]>("/v1/owner/pending"),
        ownerCall<PendingSecret[]>("/v1/owner/secrets/pending"),
        server ? readWorkspace().catch(() => undefined) : undefined,
      ]);
      setData((previous) => ({
        operations,
        secrets,
        ...(server ? { workspace: workspace ?? previous.workspace } : {}),
        loadedAt: Date.now(),
      }));
      // Alerts come from these lists, never from the stream payload.
      alerts.observe([
        ...operations.map(approvalAlert),
        ...secrets.map(secretAlert),
        ...(workspace?.pending ?? []).map(workspaceApprovalAlert),
      ]);
      setSession((current) =>
        current.state === "signed-in" ? current : { state: "signed-in" },
      );
    } catch (error) {
      handle(error);
    }
  }, [handle, server, alerts]);

  // On load, the pending read tells whether the cookie session is still valid.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Whether this broker is a workspace server is asked once per session.
  useEffect(() => {
    if (!signedIn) return;
    let current = true;
    probeWorkspace()
      .then((info) => {
        if (current) setServer(info ?? null);
      })
      .catch((error) => {
        if (current) handle(error);
      });
    return () => {
      current = false;
    };
  }, [signedIn, handle]);

  useEffect(() => {
    if (!signedIn || !server) return;
    const timer = setInterval(() => void refresh(), WORKSPACE_POLL_MS);
    return () => clearInterval(timer);
  }, [signedIn, server, refresh]);

  // The broker session lasts 15 minutes; the panel ends with it.
  useEffect(() => {
    if (session.state !== "signed-in" || !session.expiresAt) return;
    const timer = setTimeout(
      () => signOut(SIGNED_OUT_NOTICE),
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session, signOut]);

  const mode = useOwnerLive({
    enabled: signedIn,
    onChange: () => void refresh(),
    onSignedOut: () => signOut(SIGNED_OUT_NOTICE),
  });

  const workspaceWaiting = data.workspace?.pending.length ?? 0;
  const attention =
    data.operations.length + data.secrets.length + workspaceWaiting;
  const nav = [
    ...NAV,
    ...(server
      ? [
          {
            label: "Workspace",
            hash: "#/workspace",
            name: "workspace" as const,
          },
        ]
      : []),
    { label: "System", hash: "#/system", name: "system" as const },
  ];
  useEffect(() => {
    document.title =
      attention > 0 ? `(${attention}) homectl owner` : "homectl owner";
  }, [attention]);

  if (session.state === "checking")
    return <p className="center muted">Connecting to the homectl broker…</p>;
  if (session.state === "offline")
    return (
      <div className="center">
        <section className="stack">
          <h2>Broker not running</h2>
          <Notice tone="warn">{session.message}</Notice>
          <p className="small muted">
            This panel only forwards owner requests to the broker and holds
            nothing itself. Once the broker is running, try again.
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setSession({ state: "checking" });
              void refresh();
            }}
          >
            Try again
          </button>
        </section>
      </div>
    );
  if (!signedIn)
    return (
      <SignInScreen
        notice={session.state === "signed-out" ? session.notice : undefined}
        onSignedIn={(expiresAt) => {
          setSession({ state: "signed-in", expiresAt: Date.parse(expiresAt) });
          void refresh();
        }}
      />
    );

  const done = (message: string) => {
    setFlash(message);
    go("#/");
    void refresh();
  };
  const operation =
    route.name === "approval"
      ? data.operations.find((op) => op.id === route.id)
      : undefined;
  const secret =
    route.name === "secret"
      ? data.secrets.find((item) => item.id === route.id)
      : undefined;
  const liveTone =
    mode === "live" ? "good" : mode === "polling" ? "warn" : "neutral";
  const liveLabel =
    mode === "live"
      ? "Live"
      : mode === "polling"
        ? "Reconnecting"
        : mode === "offline"
          ? "Offline"
          : "Connecting";

  return (
    <>
      <header>
        <h1>
          homectl owner{" "}
          {attention > 0 ? (
            <Badge tone="count">{attention} waiting</Badge>
          ) : null}
        </h1>
        <div className="row">
          <Badge tone={liveTone}>{liveLabel}</Badge>
          <button
            type="button"
            onClick={async () => {
              await ownerCall("/v1/owner/logout").catch(() => undefined);
              signOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <nav aria-label="Owner sections">
        {nav.map((item) => (
          <button
            key={item.hash}
            type="button"
            className={route.name === item.name ? "active" : ""}
            aria-current={route.name === item.name ? "page" : undefined}
            onClick={() => go(item.hash)}
          >
            {item.label}
            {item.name === "overview" && attention > 0 ? ` (${attention})` : ""}
            {item.name === "workspace" && workspaceWaiting > 0
              ? ` (${workspaceWaiting})`
              : ""}
          </button>
        ))}
      </nav>
      <main>
        {flash ? (
          <Notice tone="good">
            {flash}{" "}
            <button type="button" onClick={() => setFlash(undefined)}>
              Dismiss
            </button>
          </Notice>
        ) : null}
        {route.name === "overview" && (
          <OverviewScreen
            data={data}
            workspaceWaiting={workspaceWaiting}
            onOpen={go}
          />
        )}
        {route.name === "approval" && !operation && data.loadedAt === 0 ? (
          <p className="muted">Loading…</p>
        ) : null}
        {route.name === "approval" && operation ? (
          <ApprovalScreen
            operation={operation}
            onDone={done}
            onError={handle}
          />
        ) : null}
        {route.name === "approval" && !operation && data.loadedAt > 0 ? (
          <Gone
            what="This approval is no longer waiting for you."
            onBack={() => go("#/")}
          />
        ) : null}
        {route.name === "secret" && !secret && data.loadedAt === 0 ? (
          <p className="muted">Loading…</p>
        ) : null}
        {route.name === "secret" && secret ? (
          <SecretScreen request={secret} onDone={done} onError={handle} />
        ) : null}
        {route.name === "secret" && !secret && data.loadedAt > 0 ? (
          <Gone
            what="This secret request is no longer waiting for you."
            onBack={() => go("#/")}
          />
        ) : null}
        {route.name === "agents" && <AgentsScreen onError={handle} />}
        {route.name === "policy" && <PolicyScreen onError={handle} />}
        {route.name === "workspace" && server === null && (
          <Notice>This broker is not a workspace server.</Notice>
        )}
        {route.name === "workspace" && server === undefined ? (
          <p className="muted">Checking…</p>
        ) : null}
        {route.name === "workspace" && server && !data.workspace ? (
          <p className="muted">Loading…</p>
        ) : null}
        {route.name === "workspace" && server && data.workspace ? (
          <WorkspaceScreen
            server={server}
            clients={data.workspace.clients}
            pending={data.workspace.pending}
            intents={data.workspace.intents}
            onChanged={refresh}
            onError={handle}
          />
        ) : null}
        {route.name === "system" && <SystemScreen onError={handle} />}
      </main>
    </>
  );
}

function Gone({ what, onBack }: { what: string; onBack: () => void }) {
  return (
    <section className="stack">
      <Notice>{what} It may have been decided, cancelled or expired.</Notice>
      <button type="button" onClick={onBack}>
        Back to what needs you
      </button>
    </section>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
