import "@/index.css";

import { CheckCircle2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useNotify, useToolInfo } from "@/helpers.js";
import { Logo, PoweredByEnpitech } from "@/views/theme/Logo.js";
import { Card, Frame, SectionTitle, Stat } from "@/views/theme/primitives.js";

function Checkout() {
  const { output } = useToolInfo<"checkout">();
  const notify = useNotify(); // notify interaction
  const fired = useRef(false);

  // Surface a success notification once the order confirmation renders.
  useEffect(() => {
    if (output?.orderId && !fired.current) {
      fired.current = true;
      notify({
        level: "success",
        message: `Order ${output.orderId} confirmed`,
        data: { orderId: output.orderId, total: output.total },
      });
    }
  }, [output?.orderId, output?.total, notify]);

  return (
    <Frame>
      <div className="flex items-center justify-between">
        <Logo size="sm" />
        <PoweredByEnpitech />
      </div>

      <Card>
        <div className="flex items-center gap-2 text-[color:var(--success)]">
          <CheckCircle2 className="h-6 w-6" />
          <SectionTitle
            title="Order confirmed"
            subtitle={`Placed on ${output?.placedOn ?? "—"}`}
          />
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          Order id <span className="font-mono">{output?.orderId}</span> — mock
          order, no real charge.
        </p>

        <div className="mt-4 flex gap-6">
          <Stat label="Lines" value={output?.lineCount ?? 0} />
          <Stat label="Total" value={output?.total ?? "—"} />
        </div>

        <ul className="mt-4 flex flex-col gap-1 text-sm">
          {(output?.lines ?? []).map((l) => (
            <li key={l.name} className="flex justify-between">
              <span>
                {l.name} ×{l.qty}
              </span>
              <span>{l.lineTotal}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Frame>
  );
}

export default Checkout;
