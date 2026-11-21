// Owner panel entry point. One session gate, one live-updated data set, and
// hash routes (no secrets or tokens in the URL). Everything the owner decides
// goes to the broker through the same-origin proxy.
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentsScreen } from "./agents";
import { MachinesScreen } from "./machines";
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
import { CopyButton } from "./copy";
import {
  ALL_DEVICES,
  type DeviceContext,
  loadContext,
  resolveContext,
  sameContext,
  saveContext,
  scopeRows,
  showsLocal,
  viewScope,
} from "./context";
import { ContextSwitcher } from "./context-switcher";
import { useOwnerLive } from "./live";
import { OverviewScreen } from "./overview";
import { PolicyScreen } from "./policy";
import { type Route, parseRoute } from "./route";
import { SecretScreen } from "./secret";
import { SignInScreen } from "./signin";
import { SystemScreen } from "./system";
import {
  Gone,
  MainNav,
  NAV,
  type NavItem,
  SidebarFoot,
  TopBar,
} from "./app-chrome";
import { readLastSection, writeLastSection } from "./last-section";
import { Notice, Toast } from "./ui";
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
  // The device context the inbox and workspace views show. Remembered per
  // viewer; it filters what is shown and changes no decision.
  const [context, setContext] = useState<DeviceContext>(loadContext);
  const chooseContext = useCallback((next: DeviceContext) => {
    saveContext(next);
    setContext(next);
  }, []);
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

  // A client that was unlinked while selected falls back to All devices.
  const clientsLoaded = data.workspace?.clients;
  useEffect(() => {
    if (clientsLoaded === undefined) return;
    const resolved = resolveContext(context, clientsLoaded);
    if (!sameContext(resolved, context)) chooseContext(resolved);
  }, [context, clientsLoaded, chooseContext]);

  const workspaceWaiting = data.workspace?.pending.length ?? 0;
  const attention =
    data.operations.length + data.secrets.length + workspaceWaiting;
  const nav: NavItem[] = [
    ...NAV,
    ...(server
      ? [
          {
            label: "Devices & backup",
            hash: "#/workspace",
            name: "workspace" as const,
            icon: "devices" as const,
          },
        ]
      : []),
    {
      label: "System",
      hash: "#/system",
      name: "system" as const,
      icon: "sliders" as const,
    },
  ];
  // The section a viewer used last is remembered (section only, never a secret),
  // but never over something that waits: "Needs you" opens first while attention
  // is above zero. Only the first load of a session restores it.
  // The decision is made once per session, after the first load. Only then
  // does what is shown get remembered, so the stored section is read first.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restored || !signedIn || data.loadedAt === 0) return;
    setRestored(true);
    const last = readLastSection();
    if (!location.hash && attention === 0 && last) go(last);
  }, [restored, signedIn, data.loadedAt, attention, go]);
  useEffect(() => {
    if (!restored || !signedIn) return;
    if (route.name === "approval" || route.name === "secret") return;
    writeLastSection(route.name);
  }, [restored, route.name, signedIn]);
  useEffect(() => {
    document.title =
      attention > 0 ? `(${attention}) homectl owner` : "homectl owner";
  }, [attention]);

  // What the views show. Without a workspace server there is nothing to filter,
  // so every view keeps its whole content and no switcher is offered.
  const view = server
    ? resolveContext(context, data.workspace?.clients)
    : ALL_DEVICES;
  const shownOperations = showsLocal(view) ? data.operations : [];
  const shownSecrets = showsLocal(view) ? data.secrets : [];
  const shownPending = scopeRows(
    view,
    data.workspace?.pending ?? [],
    (row) => row.origin,
  );
  const shownClients = scopeRows(
    view,
    data.workspace?.clients ?? [],
    (client) => client.id,
  );
  const shownIntents = scopeRows(
    view,
    data.workspace?.intents ?? [],
    (row) => row.client,
  );
  const shownAttention =
    shownOperations.length + shownSecrets.length + shownPending.length;
  const scope =
    server && data.workspace
      ? viewScope(view, data.workspace.clients, attention - shownAttention)
      : undefined;

  if (session.state === "checking")
    return <p className="center muted">Connecting to the homectl broker…</p>;
  if (session.state === "offline")
    return (
      <div className="center">
        <section className="stack">
          <h2>homectl is not running</h2>
          <p>
            Start it in a terminal you keep open, then press Try again. This is
            the command:
          </p>
          <p>
            <code>home-ctl start</code>{" "}
            <CopyButton label="command" text="home-ctl start" primary />
          </p>
          <Notice tone="warn">{session.message}</Notice>
          <p className="small muted">
            This panel only forwards owner requests to the broker and holds
            nothing itself. It opens again once homectl is running.
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

  // The owner ends the session from either place it is offered.
  const endSession = async () => {
    await ownerCall("/v1/owner/logout").catch(() => undefined);
    signOut();
  };

  return (
    <div className="shell">
      <div className="sidebar">
        <TopBar
          liveTone={liveTone}
          liveLabel={liveLabel}
          onSignOut={endSession}
        />
        <MainNav
          items={nav}
          current={route.name}
          counts={{ overview: attention, workspace: workspaceWaiting }}
          onGo={go}
        />
        <SidebarFoot onSignOut={endSession} />
      </div>
      <main className="main">
        {server &&
        data.workspace &&
        (route.name === "overview" || route.name === "workspace") ? (
          <ContextSwitcher
            context={view}
            clients={data.workspace.clients}
            onChange={chooseContext}
          />
        ) : null}
        {route.name === "overview" && (
          <OverviewScreen
            data={{
              operations: shownOperations,
              secrets: shownSecrets,
              loadedAt: data.loadedAt,
            }}
            workspaceWaiting={shownPending.length}
            scope={scope}
            onOpen={go}
            // A one-tap decision stays on this screen; the list refreshes.
            onQuickDone={(message) => {
              setFlash(message);
              void refresh();
            }}
            onError={handle}
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
            onBack={() => go("#/")}
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
        {route.name === "machines" && <MachinesScreen onError={handle} />}
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
            clients={shownClients}
            pending={shownPending}
            intents={shownIntents}
            scope={scope}
            onChanged={refresh}
            onError={handle}
          />
        ) : null}
        {route.name === "system" && <SystemScreen onError={handle} />}
      </main>
      {flash ? (
        <Toast message={flash} onDismiss={() => setFlash(undefined)} />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
