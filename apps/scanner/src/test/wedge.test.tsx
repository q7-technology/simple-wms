import { act, renderHook } from "@testing-library/react";
import { useScanWedge } from "../lib/useScanWedge";

function type(text: string, gapMs = 5, target: EventTarget = window) {
  for (const ch of text) {
    act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true })); });
    vi.advanceTimersByTime(gapMs);
  }
}

describe("useScanWedge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("captures a fast burst ending in Enter as a scan", () => {
    const onScan = vi.fn();
    renderHook(() => useScanWedge(onScan));
    type("PF-01-02-A");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onScan).toHaveBeenCalledWith("PF-01-02-A");
  });

  it("ignores slow human typing", () => {
    const onScan = vi.fn();
    renderHook(() => useScanWedge(onScan));
    type("ABC", 400);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onScan).not.toHaveBeenCalled();
  });

  it("does not capture while an input is focused, unless it is marked as a scan field", () => {
    const onScan = vi.fn();
    renderHook(() => useScanWedge(onScan));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    type("ABC123", 5, input);
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onScan).not.toHaveBeenCalled();
    input.dataset.scan = "true";
    input.value = "ABC123";
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onScan).toHaveBeenCalledWith("ABC123");
    input.remove();
  });
});
