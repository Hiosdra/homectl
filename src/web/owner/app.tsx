// Owner panel session and live data. Decisions use the same-origin broker proxy.
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
import { OfflineScreen } from "./offline";
import { SetupScreen } from "./setup-screen";
import { useSetupStatus } from "./setup-live";
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
  probeWorkspace,
  readWorkspaceSnapshot,
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
  workspace?: Awaited<ReturnType<typeof readWorkspaceSnapshot>>;
  loadedAt: number;
}

const SIGNED_OUT_NOTICE = "Your owner session ended. Sign in again.";
// Linked clients reach the server by sync, not by this broker's stream, so the
// workspace is re-read on a timer while the panel is open.
const WORKSPACE_POLL_MS = 10_000;
const readWorkspace = readWorkspaceSnapshot;

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
  // The inbox and workspace filter is remembered per viewer.
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

  // The guided setup's progress (read from the broker, never kept in the browser).
  const { setup, setSetup, reloadSetup } = useSetupStatus({
    signedIn,
    onSetupPage: signedIn && route.name === "setup",
    go,
    onError: handle,
  });

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
      void reloadSetup();
    } catch (error) {
      handle(error);
    }
  }, [handle, server, alerts, reloadSetup]);

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

  const workspaceWaiting =
    (data.workspace?.pending.length ?? 0) +
    (data.workspace?.secrets.length ?? 0);
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
  // Restore the last section once per session, unless Needs you has items.
  // Read the stored section before saving the one displayed.
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
  const shownWorkspaceSecrets = scopeRows(
    view,
    data.workspace?.secrets ?? [],
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
    shownOperations.length +
    shownSecrets.length +
    shownPending.length +
    shownWorkspaceSecrets.length;
  const scope =
    server && data.workspace
      ? viewScope(view, data.workspace.clients, attention - shownAttention)
      : undefined;

  if (session.state === "checking")
    return <p className="center muted">Connecting to the homectl broker…</p>;
  if (session.state === "offline")
    return (
      <OfflineScreen
        message={session.message}
        onRetry={() => {
          setSession({ state: "checking" });
          void refresh();
        }}
      />
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
            workspaceWaiting={
              shownPending.length + shownWorkspaceSecrets.length
            }
            setup={setup}
            onSetupChanged={setSetup}
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
            key={operation.id}
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
          <SecretScreen
            key={secret.id}
            request={secret}
            onDone={done}
            onError={handle}
          />
        ) : null}
        {route.name === "secret" && !secret && data.loadedAt > 0 ? (
          <Gone
            what="This secret request is no longer waiting for you."
            onBack={() => go("#/")}
          />
        ) : null}
        {route.name === "setup" && (
          <SetupScreen
            step={route.step}
            status={setup}
            operations={shownOperations}
            onGo={go}
            onChanged={setSetup}
            onError={handle}
          />
        )}
        {route.name === "agents" && <AgentsScreen onError={handle} />}
        {route.name === "machines" && <MachinesScreen onError={handle} />}
        {route.name === "policy" && (
          <PolicyScreen onError={handle} setup={setup} />
        )}
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
            secrets={shownWorkspaceSecrets}
            intents={shownIntents}
            scope={scope}
            onChanged={refresh}
            onError={handle}
          />
        ) : null}
        {route.name === "system" && (
          <SystemScreen onError={handle} setup={setup} />
        )}
      </main>
      {flash ? (
        <Toast message={flash} onDismiss={() => setFlash(undefined)} />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
