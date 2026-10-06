import { act, render, screen } from "@testing-library/react";
import { DING_MS, DingToast, ding } from "../ui/ding";

describe("Ding toast", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a green Ding in a status region and hides itself", () => {
    vi.useFakeTimers();
    render(<DingToast />);
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();

    act(() => ding("Picked 6 EA GHI789"));
    expect(region).toHaveTextContent("Ding! Picked 6 EA GHI789");

    // a second ding replaces the first and restarts the clock
    act(() => { vi.advanceTimersByTime(DING_MS - 100); ding("Counted 4 EA ABC123"); });
    expect(region).toHaveTextContent("Ding! Counted 4 EA ABC123");
    act(() => vi.advanceTimersByTime(DING_MS - 100));
    expect(region).toHaveTextContent("Ding! Counted 4 EA ABC123");

    act(() => vi.advanceTimersByTime(200));
    expect(region).toBeEmptyDOMElement();
  });
});
