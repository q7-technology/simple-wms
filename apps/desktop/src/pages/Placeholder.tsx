import { Main } from "../ui/Shell";
import { PageHeader } from "../ui";

export function Placeholder({ title, step }: { title: string; step: number }) {
  return (
    <Main>
      <PageHeader eyebrow={`Build step ${step}`} title={title} />
      <p className="text-sm text-muted m-0">This screen arrives with build step {step}. See docs/brief.md.</p>
    </Main>
  );
}
