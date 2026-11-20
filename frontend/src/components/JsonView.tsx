/**
 * A JSON inspector: the payload as an indented tree with syntax colours, where
 * every object and array folds. Folded, it shows how much it holds ("{ 3 keys }"),
 * so a large payload can be read from the top down.
 */
import { useState } from "react";
import { ChevronIcon } from "./icons";
import { CopyButton, cx } from "./ui";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function Primitive({ value }: { value: Json }) {
  if (typeof value === "string") return <span className="json-string">"{value}"</span>;
  if (typeof value === "number") return <span className="json-number">{value}</span>;
  return <span className="json-literal">{String(value)}</span>;
}

function Node({
  name,
  value,
  depth,
  last,
}: {
  name?: string;
  value: Json;
  depth: number;
  last: boolean;
}) {
  // Deep levels start folded so a big payload opens readable.
  const [open, setOpen] = useState(depth < 3);
  const comma = last ? null : <span className="json-punct">,</span>;
  const label =
    name === undefined ? null : (
      <>
        <span className="json-key">"{name}"</span>
        <span className="json-punct">: </span>
      </>
    );

  if (value === null || typeof value !== "object") {
    return (
      <div className="pl-5">
        {label}
        <Primitive value={value} />
        {comma}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string | undefined, Json][] = isArray
    ? value.map((item) => [undefined, item])
    : Object.entries(value);
  const [openBracket, closeBracket] = isArray ? ["[", "]"] : ["{", "}"];

  if (entries.length === 0) {
    return (
      <div className="pl-5">
        {label}
        <span className="json-punct">
          {openBracket}
          {closeBracket}
        </span>
        {comma}
      </div>
    );
  }

  const size = `${entries.length} ${isArray ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"}`;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Fold" : "Unfold"} ${name ?? "root"}`}
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center rounded text-left hover:bg-white/[0.03]"
      >
        <ChevronIcon
          width={12}
          height={12}
          className={cx("mx-1 shrink-0 text-fg-3 transition-transform group-hover:text-fg-2", open && "rotate-90")}
        />
        <span>
          {label}
          <span className="json-punct">{openBracket}</span>
          {!open && (
            <>
              <span className="mx-1 rounded bg-hover px-1 text-2xs text-fg-3">{size}</span>
              <span className="json-punct">{closeBracket}</span>
              {comma}
            </>
          )}
        </span>
      </button>
      {open && (
        <>
          <div className="ml-[9px] border-l border-line pl-2">
            {entries.map(([key, item], index) => (
              <Node
                key={key ?? index}
                name={key}
                value={item}
                depth={depth + 1}
                last={index === entries.length - 1}
              />
            ))}
          </div>
          <div className="pl-5">
            <span className="json-punct">{closeBracket}</span>
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

export function JsonView({ value, title = "JSON" }: { value: unknown; title?: string }) {
  const text = JSON.stringify(value, null, 2);
  const lines = text.split("\n").length;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-sunken/60">
      <div className="flex items-center justify-between border-b border-line bg-panel px-3.5 py-2">
        <span className="text-xs text-fg-2">
          {title}
          <span className="ml-2 text-fg-3">
            {lines} lines · {new Blob([text]).size.toLocaleString()} bytes
          </span>
        </span>
        <CopyButton value={text} label="Copy JSON" />
      </div>
      <div
        data-testid="json-view"
        className="max-h-[28rem] overflow-auto py-3 pr-4 font-mono text-xs leading-[1.7]"
      >
        <Node value={value as Json} depth={0} last />
      </div>
    </div>
  );
}
