import "@/index.css";

import { useEffect, useRef, useState } from "react";
import {
  useOpenExternal,
  useRequestModal,
  useRequestSize,
} from "enpilink/web";
import { useIntent, useNotify, useToolInfo } from "@/helpers.js";
import { Logo, PoweredByEnpitech } from "@/views/theme/Logo.js";
import { Badge, Button, Card, Frame, SectionTitle, Stat } from "@/views/theme/primitives.js";

function Product() {
  const { output } = useToolInfo<"product_details">();
  const modal = useRequestModal();
  const requestSize = useRequestSize();
  const openExternal = useOpenExternal();
  const sendIntent = useIntent();
  const notify = useNotify();

  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // resize: ask the host to fit the view to its content when it changes.
  useEffect(() => {
    if (rootRef.current) {
      requestSize({ height: rootRef.current.scrollHeight }).catch(() => {});
    }
  }, [expanded, requestSize]);

  if (!output?.found) {
    return (
      <Frame>
        <Card>No such product.</Card>
      </Frame>
    );
  }

  const p = output.product;

  return (
    <div ref={rootRef}>
      <Frame>
        <div className="flex items-center justify-between">
          <Logo size="sm" />
          <PoweredByEnpitech />
        </div>

        <Card>
          <div className="flex items-center gap-2">
            <SectionTitle title={p.name} subtitle={p.category} />
            {p.stock === 0 ? <Badge tone="danger">out of stock</Badge> : null}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{p.blurb}</p>
          <div className="mt-4 flex gap-6">
            <Stat label="Price" value={p.price} />
            <Stat label="Rating" value={`★ ${(p.ratingX10 / 10).toFixed(1)}`} />
            <Stat label="In stock" value={p.stock} />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={p.stock === 0}
              onClick={() => {
                sendIntent({
                  name: "add_to_cart",
                  params: { productId: p.id, qty: 1 },
                });
                notify({ level: "success", message: `Added ${p.name}` });
              }}
            >
              Add to cart (intent)
            </Button>
            <Button variant="secondary" onClick={() => modal.open({ params: { id: p.id } })}>
              Enlarge (modal)
            </Button>
            <Button variant="secondary" onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Hide" : "Show"} details (resize)
            </Button>
            <Button
              variant="ghost"
              onClick={() => openExternal(`https://shop.northwind.example/p/${p.id}`)}
            >
              Product page (external)
            </Button>
          </div>
        </Card>

        {expanded ? (
          <Card>
            <SectionTitle title="Specs" subtitle="This panel grows the view via useRequestSize." />
            <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
              <li>SKU: {p.id}</li>
              <li>Category: {p.category}</li>
              <li>Ships in 2–3 business days (mock).</li>
              <li>Roasted/packed at the Northwind demo facility.</li>
            </ul>
          </Card>
        ) : null}

        {modal.isOpen ? (
          <Card className="border-primary">
            <SectionTitle title={`${p.name} — enlarged`} subtitle="Rendered in a host modal." />
            <div
              className="mt-2 grid h-40 place-items-center rounded-lg text-4xl"
              style={{ background: "linear-gradient(135deg,#4A00E0 0%,#8E2DE2 100%)" }}
            >
              ☕
            </div>
          </Card>
        ) : null}
      </Frame>
    </div>
  );
}

export default Product;
