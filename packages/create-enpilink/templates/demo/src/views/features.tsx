import "@/index.css";

import { useToolInfo } from "@/helpers.js";
import { Logo, PoweredByEnpitech } from "@/views/theme/Logo.js";
import { Badge, Card, Frame, SectionTitle } from "@/views/theme/primitives.js";

function Features() {
  // tool-info: this view reads the very tool output that produced it.
  const info = useToolInfo<"feature_matrix">();
  const rows = info.output?.rows ?? [];

  return (
    <Frame>
      <div className="flex items-center justify-between">
        <Logo size="sm" />
        <PoweredByEnpitech />
      </div>

      <Card>
        <SectionTitle
          title="enpilink feature matrix"
          subtitle={`Status: ${info.status}. ${rows.length} capabilities, all 4 interaction types.`}
        />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Feature</th>
                <th className="py-1 pr-3">Hook</th>
                <th className="py-1 pr-3">Interaction</th>
                <th className="py-1">View</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hook} className="border-t border-border">
                  <td className="py-1 pr-3 font-medium">{r.feature}</td>
                  <td className="py-1 pr-3 font-mono text-xs">{r.hook}</td>
                  <td className="py-1 pr-3">
                    {r.interaction === "-" ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Badge tone="brand">{r.interaction}</Badge>
                    )}
                  </td>
                  <td className="py-1 text-muted-foreground">{r.view}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Frame>
  );
}

export default Features;
