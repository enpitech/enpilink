import "@/index.css";

import {
  useCallTool,
  useNotify,
  useSendFollowUpMessage,
  useToolInfo,
} from "@/helpers.js";
import { Logo, PoweredByEnpitech } from "@/views/theme/Logo.js";
import { Badge, Button, Card, Frame, SectionTitle, Stat } from "@/views/theme/primitives.js";

function Cart() {
  const { output } = useToolInfo<"view_cart">();
  const { callTool, isPending } = useCallTool("checkout"); // tool interaction
  const sendFollowUp = useSendFollowUpMessage(); // prompt interaction
  const notify = useNotify(); // notify interaction

  const lines = output?.lines ?? [];
  const items = lines.map((l) => ({ productId: l.productId, qty: l.qty }));

  return (
    <Frame>
      <div className="flex items-center justify-between">
        <Logo size="sm" />
        <PoweredByEnpitech />
      </div>

      <Card>
        <div className="flex items-center justify-between">
          <SectionTitle title="Your cart" />
          {output?.plusMember ? <Badge tone="brand">Plus 10% off</Badge> : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Cart id <span className="font-mono">{output?.cartId}</span> (stable —
          re-run yields the same id).
        </p>

        <table className="mt-3 w-full text-sm">
          <tbody>
            {lines.map((l) => (
              <tr key={l.productId} className="border-b border-border">
                <td className="py-1">{l.name}</td>
                <td className="py-1 text-center text-muted-foreground">×{l.qty}</td>
                <td className="py-1 text-right">{l.lineTotal}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 flex gap-6">
          <Stat label="Subtotal" value={output?.subtotal ?? "—"} />
          <Stat label="Discount" value={output?.discount ?? "—"} />
          <Stat label="Total" value={output?.total ?? "—"} />
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={isPending || lines.length === 0}
          onClick={() =>
            callTool(
              { items },
              {
                onSuccess: () =>
                  notify({ level: "success", message: "Order placed!" }),
              },
            )
          }
        >
          {isPending ? "Placing…" : "Checkout (tool)"}
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            sendFollowUp("What pairs well with the items in my Northwind cart?")
          }
        >
          Suggest pairings (prompt)
        </Button>
      </div>
    </Frame>
  );
}

export default Cart;
