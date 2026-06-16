import "@/index.css";

import { useDownload, useFiles, useOpenExternal, useUser } from "enpilink/web";
import { Download, ExternalLink, Upload } from "lucide-react";
import { type ChangeEvent, useState } from "react";
import { useToolInfo } from "@/helpers.js";
import { Logo, PoweredByEnpitech } from "@/views/theme/Logo.js";
import {
  Badge,
  Button,
  Card,
  Frame,
  SectionTitle,
  Stat,
} from "@/views/theme/primitives.js";

function Account() {
  const { output } = useToolInfo<"my_account">();
  const { locale, userAgent } = useUser(); // user interaction
  const { upload } = useFiles(); // files — apps-sdk only
  const { download } = useDownload(); // download — apps-sdk only
  const openExternal = useOpenExternal();
  const [fileNote, setFileNote] = useState<string | null>(null);

  const device = userAgent?.device?.type ?? "desktop";

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const meta = await upload(file);
      setFileNote(`Uploaded ${meta.fileName ?? file.name} (${meta.fileId}).`);
    } catch {
      // Files are Apps-SDK only — degrade gracefully on MCP Apps / no host.
      setFileNote(
        "File upload isn't available in this runtime (Apps-SDK only).",
      );
    }
  }

  async function onDownloadReceipt() {
    try {
      await download({
        contents: [
          {
            type: "resource_link",
            name: "northwind-receipt.pdf",
            uri: "https://shop.northwind.example/receipt/demo.pdf",
            mimeType: "application/pdf",
          },
        ],
      });
    } catch {
      setFileNote("Download isn't available in this runtime (Apps-SDK only).");
    }
  }

  return (
    <Frame>
      <div className="flex items-center justify-between">
        <Logo size="sm" />
        <PoweredByEnpitech />
      </div>

      <Card>
        <div className="flex items-center gap-2">
          <SectionTitle
            title={output?.name ?? "Account"}
            subtitle={output?.email}
          />
          {output?.tier ? <Badge tone="brand">{output.tier}</Badge> : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Hi from your {device} · locale {locale}.
        </p>
        <div className="mt-4 flex gap-6">
          <Stat label="Tier" value={output?.tier ?? "—"} />
          <Stat label="Points" value={output?.points ?? 0} />
        </div>
      </Card>

      <Card>
        <SectionTitle
          title="Files & links"
          subtitle="Files degrade gracefully off Apps-SDK."
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onDownloadReceipt}>
            <Download className="h-4 w-4" /> Download receipt
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-primary px-4 py-2 text-sm text-primary">
            <Upload className="h-4 w-4" /> Upload avatar
            <input type="file" className="hidden" onChange={onUpload} />
          </label>
          <Button
            variant="ghost"
            onClick={() =>
              openExternal("https://shop.northwind.example/account")
            }
          >
            <ExternalLink className="h-4 w-4" /> Manage account
          </Button>
        </div>
        {fileNote ? (
          <p className="mt-2 text-xs text-muted-foreground">{fileNote}</p>
        ) : null}
      </Card>
    </Frame>
  );
}

export default Account;
