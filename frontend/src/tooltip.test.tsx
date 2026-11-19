/** The app-wide tooltip that replaces the browser's grey title box. */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipLayer } from "./components/TooltipLayer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the tooltip layer", () => {
  it("shows an element's title in a styled tooltip on keyboard focus", () => {
    render(
      <>
        <button type="button" title="Copy URL">
          icon
        </button>
        <TooltipLayer />
      </>,
    );
    const button = screen.getByRole("button");

    act(() => {
      fireEvent.focusIn(button);
      vi.runAllTimers();
    });

    expect(screen.getByRole("tooltip")).toHaveTextContent("Copy URL");
    // The native title is moved aside, so the browser's own box never appears.
    expect(button).not.toHaveAttribute("title");
    expect(button).toHaveAttribute("data-tip", "Copy URL");

    act(() => {
      fireEvent.focusOut(button);
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("stays quiet when the title only repeats text that is fully visible", () => {
    render(
      <>
        <span tabIndex={0} title="Acme">
          Acme
        </span>
        <TooltipLayer />
      </>,
    );

    act(() => {
      fireEvent.focusIn(screen.getByText("Acme"));
      vi.runAllTimers();
    });

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes when the person clicks", () => {
    render(
      <>
        <button type="button" title="Pause deliveries">
          Pause
        </button>
        <TooltipLayer />
      </>,
    );
    act(() => {
      fireEvent.focusIn(screen.getByRole("button"));
      vi.runAllTimers();
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
