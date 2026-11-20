import { useState } from "react";
import { CheckIcon, CopyIcon, ShieldIcon } from "./icons";
import { ScrambleText } from "./motionkit";
import { Button } from "./ui";

/**
 * Shows a secret that the server will never show again (an API key, a signing
 * secret, an invitation link), with a copy button and a clear warning to store
 * it now.
 */
export function SecretReveal({ label, secret }: { label: string; secret: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the value is selectable as a fallback.
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-warn/25 bg-warn-soft/50">
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <ShieldIcon className="mt-0.5 shrink-0 text-warn" />
        <div>
          <p className="text-[13px] font-medium text-fg">{label}</p>
          <p className="mt-0.5 text-xs text-fg-2">
            Copy it now. For your security it is shown only once and cannot be recovered.
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-warn/15 bg-canvas/60 px-3.5 py-2.5">
        <code
          data-testid="secret-value"
          className="block min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-xs text-fg"
        >
          <ScrambleText text={secret} />
        </code>
        <Button size="sm" onClick={copy} icon={copied ? <CheckIcon width={13} height={13} className="text-ok" /> : <CopyIcon width={13} height={13} />}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
