import { Sidebar } from "../../../shared/frontend/Sidebar";
import { URLS } from "../../../shared/frontend/urls";

const urls = { ...URLS, analytics: "", insightSegment: URLS.segment };

export function Nav() {
  return <Sidebar urls={urls} currentModule="insight" />;
}
