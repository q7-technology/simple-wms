import { Link } from "react-router-dom";
import { Main } from "../ui/Shell";
import { PANEL_GROUPS, type PanelZone } from "../ui/panels";

const ZONE_SWATCH: Record<PanelZone, string> = {
  leaving: "bg-[#E07A1F]", arriving: "bg-brand", stored: "bg-[#1F8A84]", setup: "bg-muted",
};

/** Every part of the warehouse in one place, like the main menu in a game. */
export function Menu() {
  return (
    <Main>
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[26px] leading-9 font-extrabold tracking-[-0.3px]">All panels</h1>
        <p className="m-0 text-[13px] text-muted">Every part of the warehouse, like the main menu in a game.</p>
      </div>
      <nav aria-label="All panels" className="flex flex-col gap-6">
        {PANEL_GROUPS.map((g) => (
          <section key={g.title} aria-labelledby={`panels-${g.zone}`} className="flex flex-col gap-2.5">
            <h2 id={`panels-${g.zone}`} className="m-0 eyebrow text-muted">{g.title}</h2>
            <ul className="m-0 p-0 list-none grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
              {g.items.map((p) => (
                <li key={p.to}>
                  <Link
                    to={p.to}
                    className="flex items-center gap-3 min-h-16 px-3.5 py-3 rounded-[14px] border border-line-soft bg-card no-underline shadow-[0_2px_6px_rgba(24,35,61,0.04)] hover:border-brand hover:bg-brand-tint"
                  >
                    <span aria-hidden="true" className={`w-3 h-3 shrink-0 rounded ${ZONE_SWATCH[g.zone]}`} />
                    <span className="grow min-w-0">
                      <span className="block text-[15px] font-extrabold text-ink">{p.label}</span>
                      <span className="block text-xs text-muted">{p.blurb}</span>
                    </span>
                    {p.later && (
                      <span className="px-2 py-0.5 rounded-full bg-warning text-warning-ink text-[11px] font-extrabold">Later</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </Main>
  );
}
