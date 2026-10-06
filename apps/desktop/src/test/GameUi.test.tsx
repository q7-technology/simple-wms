import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAction } from "../lib/useApi";
import { Chip, DetailHeader, DetailPanel, Table } from "../ui";
import { ToastHost } from "../ui/toast";

function Doer({ ding = true, fail = false }: { ding?: boolean; fail?: boolean }) {
  const action = useAction({ ding });
  return (
    <button type="button" onClick={() => void action.run(async () => { if (fail) throw new Error("no"); return 1; })}>
      Go
    </button>
  );
}

describe("Game Mode touches", () => {
  it("says Ding! after an action goes through", async () => {
    const user = userEvent.setup();
    render(<><ToastHost /><Doer /></>);
    expect(screen.queryByText("Ding!")).not.toBeInTheDocument();
    await user.click(screen.getByText("Go"));
    expect(await screen.findByText("Ding!")).toBeInTheDocument();
  });

  it("stays quiet for a look-only action and for a failure", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<><ToastHost /><Doer ding={false} /></>);
    await user.click(screen.getByText("Go"));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("Ding!")).not.toBeInTheDocument();
    unmount();
    render(<><ToastHost /><Doer fail /></>);
    await user.click(screen.getByText("Go"));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("Ding!")).not.toBeInTheDocument();
  });

  it("keeps a chip's name its word when it shows a count", () => {
    render(<Chip active count={3} onClick={() => {}}>Picking</Chip>);
    const chip = screen.getByRole("button", { name: "Picking" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveTextContent("Picking3");
  });

  it("gives a wide table a floor so it scrolls rather than squashes", () => {
    const { container } = render(
      <Table
        columns={[
          { key: "a", header: "A", width: "200px", render: (r: { id: string }) => r.id },
          { key: "b", header: "B", render: (r: { id: string }) => r.id },
        ]}
        rows={[{ id: "x" }]}
        rowKey={(r) => r.id}
      />,
    );
    const inner = container.querySelector(".card > div") as HTMLElement;
    // 200 + 120 for the flexible column + 40 padding + one 16px column gap
    expect(inner.style.minWidth).toBe("376px");
  });

  it("marks a detail panel that holds only the nothing-picked hint", () => {
    render(<DetailPanel><DetailHeader eyebrow="Delivery" title="—" subtitle="Pick one" /></DetailPanel>);
    expect(screen.getByText("Pick one").parentElement).toHaveAttribute("data-idle");
  });
});
