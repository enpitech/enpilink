import "@/index.css";

import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { useNotify, useToolInfo } from "@/helpers.js";
import { Logo, PoweredByEnpitech } from "@/views/theme/Logo.js";
import { Card, Frame, SectionTitle } from "@/views/theme/primitives.js";

function SignIn() {
  const { output } = useToolInfo<"sign_in">();
  const notify = useNotify(); // notify interaction
  const fired = useRef(false);

  useEffect(() => {
    if (output && !fired.current) {
      fired.current = true;
      notify({
        level: output.ok ? "success" : "warning",
        message: output.message,
      });
    }
  }, [output, notify]);

  return (
    <Frame>
      <div className="flex items-center justify-between">
        <Logo size="sm" />
        <PoweredByEnpitech />
      </div>

      <Card>
        <div
          className={`flex items-center gap-2 ${
            output?.ok
              ? "text-[color:var(--success)]"
              : "text-[color:var(--warning)]"
          }`}
        >
          {output?.ok ? (
            <CheckCircle2 className="h-6 w-6" />
          ) : (
            <XCircle className="h-6 w-6" />
          )}
          <SectionTitle
            title={output?.ok ? "Signed in" : "Try again"}
            subtitle={output?.message}
          />
        </div>
        {output?.ok ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Welcome back, {output.customerName}. (Mock session — the demo OTP is
            always 000000.)
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            The demo one-time code is <span className="font-mono">000000</span>.
          </p>
        )}
      </Card>
    </Frame>
  );
}

export default SignIn;
