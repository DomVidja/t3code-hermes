import { createFileRoute } from "@tanstack/react-router";

import { HermesPanel } from "../components/hermes/HermesPanel";

import { validateHermesSearch } from "../components/hermes/hermesNavigation";

export const Route = createFileRoute("/hermes")({
  validateSearch: validateHermesSearch,
  component: HermesRoute,
});

function HermesRoute() {
  const target = Route.useSearch();
  return <HermesPanel target={target} />;
}
