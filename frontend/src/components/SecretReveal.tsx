import { useState } from "react";
import { Button } from "./ui";

/**
 * Shows a secret that the server will never show again (an API key or a signing
 * secret), with a copy button and a clear warning to store it now.
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
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-900">{label}</p>
      <p className="mt-1 text-xs text-amber-800">
        Copy it now. For your security it is shown only once and cannot be recovered.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code
          data-testid="secret-value"
          className="block flex-1 select-all overflow-x-auto rounded bg-white px-3 py-2 font-mono text-xs text-slate-900 ring-1 ring-amber-200"
        >
          {secret}
        </code>
        <Button size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
