import { BarChart3, PlugZap, SlidersHorizontal, Wrench } from "lucide-react";
import { Suspense } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";
import { Button } from "@/components/ui/button.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { useAdminTokenStore } from "@/lib/admin-token-store.js";
import { useAuthStore } from "@/lib/auth-store.js";
import { connectToServer } from "@/lib/mcp/index.js";
import { AdminLogin } from "./admin-login.js";
import Configuration from "./configuration/index.js";
import Dashboard from "./dashboard/index.js";
import { Header } from "./header.js";
import { ToolPanel } from "./tool-panel/index.js";
import ToolsList from "./tools-list/index.js";

const TOOLS_SPLIT_GROUP_ID = "devtools-tools-split";
const TOOLS_LIST_PANEL_ID = "tools-list";
const TOOL_PANEL_ID = "tool-panel";

/**
 * The original playground body (tool runner). Unchanged behaviour: it requires
 * an MCP connection and prompts to connect otherwise. Extracted so the
 * top-level tab nav can switch between it and the Dashboard.
 */
function Playground() {
  const { status, requiresAuth } = useAuthStore();
  const isConnected = status === "authenticated";

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: TOOLS_SPLIT_GROUP_ID,
    panelIds: [TOOLS_LIST_PANEL_ID, TOOL_PANEL_ID],
    storage: localStorage,
  });

  if (!isConnected) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            {status === "connecting"
              ? "Connecting to server..."
              : requiresAuth
                ? "Authentication required to access this server."
                : "Not connected to a server."}
          </p>
          {status !== "connecting" && (
            <Button variant="secondary" onClick={connectToServer}>
              <PlugZap className="size-3.5" />
              Connect
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      id="devtools-card-body"
      className="relative flex min-h-0 min-w-0 flex-1"
    >
      <Group
        orientation="horizontal"
        id={TOOLS_SPLIT_GROUP_ID}
        className="flex min-h-0 min-w-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel
          id={TOOLS_LIST_PANEL_ID}
          defaultSize={380}
          minSize={250}
          maxSize={510}
          className="min-h-0 min-w-0"
        >
          <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
            <Suspense fallback={null}>
              <ToolsList />
            </Suspense>
          </aside>
        </Panel>
        <Separator className="w-px shrink-0 bg-border transition-colors hover:bg-ring data-separator-active:bg-ring" />
        <Panel id={TOOL_PANEL_ID} minSize={320} className="min-h-0 min-w-0">
          <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
            <Suspense fallback={null}>
              <ToolPanel />
            </Suspense>
          </main>
        </Panel>
      </Group>
    </div>
  );
}

function AppLayout() {
  // Prod admin gate (M6.5): when a data API has returned 401 and we don't yet
  // have a token, show the login screen instead of the (empty) dashboard. In
  // dev the server never 401s, so `authRequired` stays false and this is a
  // no-op — the local dashboard is unchanged/frictionless.
  const authRequired = useAdminTokenStore((s) => s.authRequired);
  const token = useAdminTokenStore((s) => s.token);

  if (authRequired && !token) {
    return (
      <div className="grid h-screen grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground">
        <Header />
        <AdminLogin />
      </div>
    );
  }

  return (
    <div className="grid h-screen grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground">
      <Header />
      <Tabs
        defaultValue="dashboard"
        className="grid min-h-0 grid-rows-[auto_1fr] gap-0"
      >
        <div className="border-b border-border px-4 py-2">
          <TabsList variant="line">
            <TabsTrigger value="dashboard" data-testid="tab-dashboard">
              <BarChart3 className="size-3.5" />
              Dashboard
            </TabsTrigger>
            <TabsTrigger value="configuration" data-testid="tab-configuration">
              <SlidersHorizontal className="size-3.5" />
              Configuration
            </TabsTrigger>
            <TabsTrigger value="playground" data-testid="tab-playground">
              <Wrench className="size-3.5" />
              Playground
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="dashboard" className="min-h-0 overflow-hidden">
          <Dashboard />
        </TabsContent>
        <TabsContent value="configuration" className="min-h-0 overflow-hidden">
          <Configuration />
        </TabsContent>
        <TabsContent value="playground" className="min-h-0 overflow-hidden">
          <Playground />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default AppLayout;
