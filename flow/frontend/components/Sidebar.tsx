import { useEffect, useState } from "react";
import { useFlowEditor } from "../store/flow-editor";
import { getChannelTypes } from "../config/trigger-fields";
import {
  NODE_TYPE_REGISTRY,
  USER_FLOW_SIDEBAR_ORDER,
  CONTENT_FLOW_SIDEBAR_ORDER,
  type FlowDomain,
  type NodeTypeKey,
  type NodeTypeConfig,
  type SidebarSection,
} from "../../nodeTypeRegistry";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../../shared/frontend/ui/tooltip";
import { XIcon, TikTokIcon, YouTubeIcon, GitHubIcon } from "../../../shared/frontend/ui/icons";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { computeAddPosition } from "../lib/compute-add-position";

interface DraggableItemProps {
  type: string;
  label: string;
  description: string;
  color: string;
  icon: React.ReactNode;
}

// Only 767px-and-below gets a click handler at all — desktop keeps drag-only, matching the
// md: 768px breakpoint the grid layout switches on (see Sidebar's grid className below).
const MOBILE_QUERY = "(max-width: 767.98px)";

function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

function DraggableItem({ type, label, description, color, icon }: DraggableItemProps) {
  const addNode = useFlowEditor((s) => s.addNode);
  const isMobile = useIsMobileViewport();
  const { toast } = useToast();
  const T = useT();

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/reactflow-type", type);
    e.dataTransfer.effectAllowed = "move";
  };

  const onClick = () => {
    if (!isMobile) return;
    const { reactFlowInstance, nodes } = useFlowEditor.getState();
    const wrapper = document.querySelector(".react-flow");
    if (!reactFlowInstance || !wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const center = reactFlowInstance.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    const position = computeAddPosition(center, nodes);
    const added = addNode(type, position);
    if (!added) {
      toast({ title: T({ en: "A flow can only have one trigger node", zh: "一个流程只能有一个触发节点" }), variant: "destructive" });
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          draggable
          onDragStart={onDragStart}
          onClick={onClick}
          className={`flex flex-col items-center gap-1 p-2 rounded-lg border cursor-grab active:cursor-grabbing hover:shadow-sm transition-shadow text-center ${color}`}
        >
          <span className="text-lg leading-none">{icon}</span>
          <span className="text-xs font-medium text-foreground leading-tight">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}

interface SectionItem {
  key: string;
  el: React.ReactNode;
}

// USER_FLOW_SIDEBAR_ORDER / CONTENT_FLOW_SIDEBAR_ORDER (nodeTypeRegistry.ts) are each domain's
// single source of truth for item order within a section — sort by the current domain's order
// so user-flow and content-flow Sidebars can be reordered independently of one another.
function sortByOrder(items: SectionItem[], order: string[]): React.ReactNode[] {
  return [...items]
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    .map((i) => i.el);
}

// Icon per registry key — the icon components themselves stay frontend-side; the exhaustive
// Record over NodeTypeKey means a new registry entry won't compile until it gets an icon here.
// xTrigger is null: its Sidebar items are dynamic per channelType with CHANNEL_TYPES' own icons.
const NODE_ICONS: Record<NodeTypeKey, React.ReactNode> = {
  xTrigger: null,
  cronTrigger: "⏰",
  waitForEvent: "🔍",
  userPropsCondition: "👤",
  xAction: <XIcon className="w-4 h-4" />,
  addToList: "📋",
  xContentTrigger: <XIcon className="w-4 h-4" />,
  youtubeContentTrigger: <YouTubeIcon className="w-4 h-4" />,
  githubContentTrigger: <GitHubIcon className="w-4 h-4" />,
  xContentAction: <XIcon className="w-4 h-4" />,
  tiktokContentAction: <TikTokIcon className="w-4 h-4" />,
  youtubeContentAction: <YouTubeIcon className="w-4 h-4" />,
  videoAction: "🎬",
  videoCondition: "👁️",
  youtubeCondition: "📊",
  wait: "⏳",
  timeCondition: "🕐",
  abSplit: "⚡",
  webhook: "🔗",
};

// Item colour is a function of the section (the same three classes the hand-written items used).
const SECTION_COLORS: Record<SidebarSection, string> = {
  triggers: "border-primary/30 bg-primary/5",
  actions: "border-accent bg-accent/50",
  flowControl: "border-secondary bg-secondary/30",
};

export default function Sidebar() {
  const T = useT();
  const { locale } = useLocale();
  const domain: FlowDomain = useFlowEditor((s) => s.flowDomain);
  const sidebarOrder = domain === "content" ? CONTENT_FLOW_SIDEBAR_ORDER : USER_FLOW_SIDEBAR_ORDER;

  // Section membership, label, description, and colour all derive from the registry entry —
  // formerly one hand-written JSX block per node type.
  const sections: Record<SidebarSection, SectionItem[]> = { triggers: [], actions: [], flowControl: [] };
  for (const key of Object.keys(NODE_TYPE_REGISTRY) as NodeTypeKey[]) {
    // Widened to the interface: per-key literal types would make optional facets (label,
    // description) inaccessible on entries that omit them (e.g. xTrigger).
    const cfg: NodeTypeConfig = NODE_TYPE_REGISTRY[key];
    if (cfg.domain !== "both" && cfg.domain !== domain) continue;

    if (key === "xTrigger") {
      // Dynamic: one palette item per channel type, labelled/described from CHANNEL_TYPES —
      // the registry deliberately carries no static label/description for xTrigger.
      for (const ct of getChannelTypes(locale)) {
        sections[cfg.sidebarSection].push({
          key,
          el: (
            <DraggableItem
              key={ct.channelType}
              type={key}
              label={T({ en: `${ct.label} Trigger`, zh: `${ct.label} 触发器` })}
              description={T({ en: `${ct.events.length} triggers`, zh: `${ct.events.length} 个触发器` })}
              color={SECTION_COLORS[cfg.sidebarSection]}
              icon={<ct.icon className="w-4 h-4" />}
            />
          ),
        });
      }
      continue;
    }

    sections[cfg.sidebarSection].push({
      key,
      el: (
        <DraggableItem
          key={key}
          type={key}
          label={T(cfg.label ?? { en: key, zh: key })}
          description={T(cfg.description ?? { en: "", zh: "" })}
          color={SECTION_COLORS[cfg.sidebarSection]}
          icon={NODE_ICONS[key]}
        />
      ),
    });
  }

  return (
    <TooltipProvider>
      <aside className="w-24 md:w-60 border-r border-border bg-background p-4 overflow-y-auto">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{T({ en: "Triggers", zh: "触发器" })}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-6">{sortByOrder(sections.triggers, sidebarOrder)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{T({ en: "Actions", zh: "动作" })}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-6">{sortByOrder(sections.actions, sidebarOrder)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{T({ en: "Flow Control", zh: "流程控制" })}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">{sortByOrder(sections.flowControl, sidebarOrder)}</div>
      </aside>
    </TooltipProvider>
  );
}
