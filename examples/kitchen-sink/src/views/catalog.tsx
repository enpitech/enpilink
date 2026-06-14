import "@/index.css";

import { useViewState, useRequestModal } from "enpilink/web";
import { useCallTool, useIntent, useNotify, useToolInfo } from "@/helpers.js";
import { Logo, PoweredByEnpitech } from "@/views/theme/Logo.js";
import { Badge, Button, Card, Frame, SectionTitle } from "@/views/theme/primitives.js";

type SortKey = "default" | "price-asc" | "price-desc" | "rating" | "name";

function Catalog() {
  const { output } = useToolInfo<"browse_catalog">();
  // view-state: a client-side sort persisted across remounts.
  const [prefs, setPrefs] = useViewState<{ clientSort: SortKey }>({
    clientSort: "default",
  });
  const { callTool } = useCallTool("product_details"); // tool interaction
  const sendIntent = useIntent(); // intent interaction
  const notify = useNotify(); // notify interaction
  const modal = useRequestModal();

  const products = [...(output?.products ?? [])];
  if (prefs.clientSort === "price-asc")
    products.sort((a, b) => a.priceCents - b.priceCents);
  if (prefs.clientSort === "price-desc")
    products.sort((a, b) => b.priceCents - a.priceCents);
  if (prefs.clientSort === "rating")
    products.sort((a, b) => b.ratingX10 - a.ratingX10);
  if (prefs.clientSort === "name")
    products.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Frame>
      <div className="flex items-center justify-between">
        <Logo size="sm" />
        <PoweredByEnpitech />
      </div>

      <Card>
        <SectionTitle
          title="Catalog"
          subtitle={`${output?.count ?? 0} item(s). Sort persists via useViewState.`}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {(["default", "price-asc", "price-desc", "rating", "name"] as SortKey[]).map(
            (k) => (
              <button
                key={k}
                type="button"
                onClick={() => setPrefs((p) => ({ ...p, clientSort: k }))}
                className={`rounded-full px-3 py-1 text-xs border ${
                  prefs.clientSort === k
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground"
                }`}
              >
                {k}
              </button>
            ),
          )}
        </div>
      </Card>

      <div className="flex flex-col gap-3">
        {products.map((p) => (
          <Card key={p.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{p.name}</span>
                  <Badge tone="neutral">{p.category}</Badge>
                  {p.stock === 0 ? <Badge tone="danger">out of stock</Badge> : null}
                </div>
                <p className="text-sm text-muted-foreground">{p.blurb}</p>
                <p className="mt-1 text-sm">
                  {p.price} · ★ {(p.ratingX10 / 10).toFixed(1)}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => callTool({ productId: p.id })}>
                Details (tool)
              </Button>
              <Button
                variant="secondary"
                onClick={() => modal.open({ params: { productId: p.id } })}
              >
                Quick look (modal)
              </Button>
              <Button
                variant="secondary"
                disabled={p.stock === 0}
                onClick={() => {
                  sendIntent({
                    name: "add_to_cart",
                    params: { productId: p.id, qty: 1 },
                  });
                  notify({
                    level: "success",
                    message: `Added ${p.name} to cart`,
                  });
                }}
              >
                Add to cart (intent)
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {modal.isOpen ? (
        <Card className="border-primary">
          <SectionTitle title="Quick look" subtitle="Rendered in a host modal (useRequestModal)." />
          <p className="mt-2 text-sm">
            Selected product:{" "}
            <span className="font-mono">
              {String((modal.params as { productId?: string })?.productId ?? "—")}
            </span>
          </p>
        </Card>
      ) : null}
    </Frame>
  );
}

export default Catalog;
