import "@/index.css";

import { useDisplayMode } from "enpilink/web";
import { Maximize2, Minimize2 } from "lucide-react";
import { useToolInfo } from "@/helpers.js";
import { Logo, PoweredByEnpitech } from "@/views/theme/Logo.js";
import {
  Badge,
  Button,
  Card,
  Frame,
  SectionTitle,
} from "@/views/theme/primitives.js";

const STATUS_TONE = {
  delivered: "success",
  shipped: "brand",
  processing: "warning",
} as const;

function Orders() {
  const { output } = useToolInfo<"my_orders">();
  const [mode, setMode] = useDisplayMode(); // display-mode interaction
  const isFull = mode === "fullscreen";

  return (
    <Frame>
      <div className="flex items-center justify-between">
        <Logo size="sm" />
        <PoweredByEnpitech />
      </div>

      <Card>
        <div className="flex items-center justify-between">
          <SectionTitle
            title={`${output?.customerName ?? "Your"} orders`}
            subtitle={`Display mode: ${mode}`}
          />
          <Button
            variant="secondary"
            onClick={() => setMode(isFull ? "inline" : "fullscreen")}
          >
            {isFull ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
            {isFull ? "Inline" : "Fullscreen"}
          </Button>
        </div>
      </Card>

      <div className={`grid gap-3 ${isFull ? "sm:grid-cols-2" : ""}`}>
        {(output?.orders ?? []).map((o) => (
          <Card key={o.id}>
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm">{o.id}</span>
              <Badge tone={STATUS_TONE[o.status]}>{o.status}</Badge>
            </div>
            <div className="mt-2 flex items-center justify-between text-sm text-muted-foreground">
              <span>{o.date}</span>
              <span>
                {o.itemCount} item(s) · {o.total}
              </span>
            </div>
          </Card>
        ))}
      </div>
    </Frame>
  );
}

export default Orders;
