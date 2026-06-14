import "@/index.css";

import { useDisplayMode, useUser } from "enpilink/web";
import { BookOpen, Sparkles } from "lucide-react";
import {
  useIntent,
  useNotify,
  useSendFollowUpMessage,
  useToolInfo,
} from "@/helpers.js";
import { Logo, PoweredByEnpitech } from "@/views/theme/Logo.js";
import {
  Badge,
  Button,
  Card,
  Frame,
  SectionTitle,
} from "@/views/theme/primitives.js";

function Home() {
  const { output } = useToolInfo<"home">();
  const { locale, userAgent } = useUser();
  const [mode, setMode] = useDisplayMode();
  const sendFollowUp = useSendFollowUpMessage(); // prompt interaction
  const notify = useNotify(); // notify interaction
  const sendIntent = useIntent(); // intent interaction

  const device = userAgent?.device?.type ?? "desktop";
  const featured = output?.featured ?? [];

  return (
    <Frame>
      <div className="flex items-center justify-between">
        <Logo />
        <PoweredByEnpitech />
      </div>

      <Card>
        <SectionTitle
          title={`Hi from Northwind 👋`}
          subtitle={`Detected ${device} · locale ${locale}. Today is ${output?.today ?? "—"}.`}
        />
        <p className="mt-2 text-sm text-muted-foreground">
          This is the enpilink kitchen-sink: a generic demo that exercises every
          framework feature and all four mcp-ui interaction types. Mock data
          only.
        </p>
      </Card>

      <Card>
        <SectionTitle title="Featured" />
        <ul className="mt-2 flex flex-col gap-2">
          {featured.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between text-sm"
            >
              <span>{f.name}</span>
              <Badge tone="brand">{f.price}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <SectionTitle
          title="Try the interaction types"
          subtitle="prompt · notify · intent — wired live here."
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            onClick={() =>
              sendFollowUp("Recommend a Northwind coffee for a beginner.")
            }
          >
            <Sparkles className="h-4 w-4" /> Ask the model (prompt)
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              notify({
                level: "success",
                message: "Saved Northwind to favorites!",
              })
            }
          >
            Notify me (notify)
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              sendIntent({ name: "open_catalog", params: { source: "home" } })
            }
          >
            Open catalog (intent)
          </Button>
        </div>
      </Card>

      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-primary underline"
          onClick={() =>
            setMode(mode === "fullscreen" ? "inline" : "fullscreen")
          }
        >
          {mode === "fullscreen" ? "Collapse" : "Expand"} (display-mode)
        </button>
        <a
          className="inline-flex items-center gap-1 text-primary underline"
          href="https://docs.enpitech.dev"
          target="_blank"
          rel="noreferrer"
        >
          <BookOpen className="h-4 w-4" /> Docs
        </a>
      </div>
    </Frame>
  );
}

export default Home;
