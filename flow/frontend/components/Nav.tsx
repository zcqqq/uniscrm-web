import { Sidebar, type CurrentModule } from "../../../shared/frontend/Sidebar";
import { URLS } from "../../../shared/frontend/urls";

// flow is served from this worker's own origin, so its menu hrefs stay relative — that is
// what lets Sidebar's isItemActive match "/" and "/content" against the current pathname.
const urls = { ...URLS, flow: "", insightSegment: URLS.segment };

interface NavProps {
  // User Flow sits under Social, Content Flow under Content — the same worker serves both,
  // so the caller says which group should be highlighted.
  currentModule: CurrentModule;
}

export function Nav({ currentModule }: NavProps) {
  return <Sidebar urls={urls} currentModule={currentModule} />;
}
