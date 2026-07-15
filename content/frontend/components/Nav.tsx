// content/frontend/components/Nav.tsx
import { Sidebar } from "../../../shared/frontend/Sidebar";
import { URLS } from "../../../shared/frontend/urls";

const urls = { ...URLS, content: "" };

export function Nav() {
  return <Sidebar urls={urls} currentModule="content" />;
}
