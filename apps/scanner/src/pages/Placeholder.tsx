import { Header, Main, Screen } from "../ui";

export function Placeholder({ title }: { title: string }) {
  return (
    <Screen>
      <Header eyebrow="Build step 3" title={title} />
      <Main><p className="text-sm text-muted m-0">This screen is being built.</p></Main>
    </Screen>
  );
}
