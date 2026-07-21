import { useFlowEditor } from "../store/flow-editor";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import { NODE_TYPE_REGISTRY, USER_FLOW_SIDEBAR_ORDER, CONTENT_FLOW_SIDEBAR_ORDER, type FlowDomain } from "../../nodeTypeRegistry";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../../shared/frontend/ui/tooltip";
import { XIcon, TikTokIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";

interface DraggableItemProps {
  type: string;
  label: string;
  description: string;
  color: string;
  icon: React.ReactNode;
}

function DraggableItem({ type, label, description, color, icon }: DraggableItemProps) {
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/reactflow-type", type);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          draggable
          onDragStart={onDragStart}
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

export default function Sidebar() {
  const domain: FlowDomain = useFlowEditor((s) => s.flowDomain);
  const visible = (nodeTypeKey: string) => {
    const cfg = NODE_TYPE_REGISTRY[nodeTypeKey];
    return !cfg || cfg.domain === "both" || cfg.domain === domain;
  };
  const sidebarOrder = domain === "content" ? CONTENT_FLOW_SIDEBAR_ORDER : USER_FLOW_SIDEBAR_ORDER;

  const triggerItems: SectionItem[] = [];
  if (visible("xTrigger")) {
    for (const ct of CHANNEL_TYPES) {
      triggerItems.push({
        key: "xTrigger",
        el: (
          <DraggableItem
            key={ct.channelType}
            type="xTrigger"
            label={`${ct.label} Trigger`}
            description={`${ct.events.length} triggers`}
            color="border-primary/30 bg-primary/5"
            icon={<ct.icon className="w-4 h-4" />}
          />
        ),
      });
    }
  }
  if (visible("cronTrigger")) {
    triggerItems.push({
      key: "cronTrigger",
      el: <DraggableItem key="cronTrigger" type="cronTrigger" label={NODE_TYPE_REGISTRY.cronTrigger.label!} description={NODE_TYPE_REGISTRY.cronTrigger.description!} color="border-primary/30 bg-primary/5" icon="⏰" />,
    });
  }
  if (visible("xContentTrigger")) {
    triggerItems.push({
      key: "xContentTrigger",
      el: <DraggableItem key="xContentTrigger" type="xContentTrigger" label={NODE_TYPE_REGISTRY.xContentTrigger.label!} description={NODE_TYPE_REGISTRY.xContentTrigger.description!} color="border-primary/30 bg-primary/5" icon={<XIcon className="w-4 h-4" />} />,
    });
  }
  if (visible("youtubeContentTrigger")) {
    triggerItems.push({
      key: "youtubeContentTrigger",
      el: <DraggableItem key="youtubeContentTrigger" type="youtubeContentTrigger" label={NODE_TYPE_REGISTRY.youtubeContentTrigger.label!} description={NODE_TYPE_REGISTRY.youtubeContentTrigger.description!} color="border-primary/30 bg-primary/5" icon={<YouTubeIcon className="w-4 h-4" />} />,
    });
  }

  const actionItems: SectionItem[] = [];
  if (visible("addToList")) {
    actionItems.push({
      key: "addToList",
      el: <DraggableItem key="addToList" type="addToList" label={NODE_TYPE_REGISTRY.addToList.label!} description={NODE_TYPE_REGISTRY.addToList.description!} color="border-accent bg-accent/50" icon="📋" />,
    });
  }
  if (visible("xAction")) {
    actionItems.push({
      key: "xAction",
      el: <DraggableItem key="xAction" type="xAction" label={NODE_TYPE_REGISTRY.xAction.label!} description={NODE_TYPE_REGISTRY.xAction.description!} color="border-accent bg-accent/50" icon={<XIcon className="w-4 h-4" />} />,
    });
  }
  if (visible("webhook")) {
    actionItems.push({
      key: "webhook",
      el: <DraggableItem key="webhook" type="webhook" label={NODE_TYPE_REGISTRY.webhook.label!} description={NODE_TYPE_REGISTRY.webhook.description!} color="border-accent bg-accent/50" icon="🔗" />,
    });
  }
  if (visible("changeUserProps")) {
    actionItems.push({
      key: "changeUserProps",
      el: <DraggableItem key="changeUserProps" type="changeUserProps" label={NODE_TYPE_REGISTRY.changeUserProps.label!} description={NODE_TYPE_REGISTRY.changeUserProps.description!} color="border-accent bg-accent/50" icon="✏️" />,
    });
  }
  if (visible("xContentAction")) {
    actionItems.push({
      key: "xContentAction",
      el: <DraggableItem key="xContentAction" type="xContentAction" label={NODE_TYPE_REGISTRY.xContentAction.label!} description={NODE_TYPE_REGISTRY.xContentAction.description!} color="border-accent bg-accent/50" icon={<XIcon className="w-4 h-4" />} />,
    });
  }
  if (visible("tiktokContentAction")) {
    actionItems.push({
      key: "tiktokContentAction",
      el: <DraggableItem key="tiktokContentAction" type="tiktokContentAction" label={NODE_TYPE_REGISTRY.tiktokContentAction.label!} description={NODE_TYPE_REGISTRY.tiktokContentAction.description!} color="border-accent bg-accent/50" icon={<TikTokIcon className="w-4 h-4" />} />,
    });
  }
  if (visible("youtubeContentAction")) {
    actionItems.push({
      key: "youtubeContentAction",
      el: <DraggableItem key="youtubeContentAction" type="youtubeContentAction" label={NODE_TYPE_REGISTRY.youtubeContentAction.label!} description={NODE_TYPE_REGISTRY.youtubeContentAction.description!} color="border-accent bg-accent/50" icon={<YouTubeIcon className="w-4 h-4" />} />,
    });
  }
  if (visible("videoAction")) {
    actionItems.push({
      key: "videoAction",
      el: <DraggableItem key="videoAction" type="videoAction" label={NODE_TYPE_REGISTRY.videoAction.label!} description={NODE_TYPE_REGISTRY.videoAction.description!} color="border-accent bg-accent/50" icon="🎬" />,
    });
  }
  const flowControlItems: SectionItem[] = [];
  if (visible("waitForEvent")) {
    flowControlItems.push({
      key: "waitForEvent",
      el: <DraggableItem key="waitForEvent" type="waitForEvent" label={NODE_TYPE_REGISTRY.waitForEvent.label!} description={NODE_TYPE_REGISTRY.waitForEvent.description!} color="border-secondary bg-secondary/30" icon="🔍" />,
    });
  }
  if (visible("wait")) {
    flowControlItems.push({
      key: "wait",
      el: <DraggableItem key="wait" type="wait" label={NODE_TYPE_REGISTRY.wait.label!} description={NODE_TYPE_REGISTRY.wait.description!} color="border-secondary bg-secondary/30" icon="⏳" />,
    });
  }
  if (visible("timeCondition")) {
    flowControlItems.push({
      key: "timeCondition",
      el: <DraggableItem key="timeCondition" type="timeCondition" label={NODE_TYPE_REGISTRY.timeCondition.label!} description={NODE_TYPE_REGISTRY.timeCondition.description!} color="border-secondary bg-secondary/30" icon="🕐" />,
    });
  }
  if (visible("userPropsCondition")) {
    flowControlItems.push({
      key: "userPropsCondition",
      el: <DraggableItem key="userPropsCondition" type="userPropsCondition" label={NODE_TYPE_REGISTRY.userPropsCondition.label!} description={NODE_TYPE_REGISTRY.userPropsCondition.description!} color="border-secondary bg-secondary/30" icon="👤" />,
    });
  }
  if (visible("abSplit")) {
    flowControlItems.push({
      key: "abSplit",
      el: <DraggableItem key="abSplit" type="abSplit" label={NODE_TYPE_REGISTRY.abSplit.label!} description={NODE_TYPE_REGISTRY.abSplit.description!} color="border-secondary bg-secondary/30" icon="⚡" />,
    });
  }
  if (visible("videoCondition")) {
    flowControlItems.push({
      key: "videoCondition",
      el: <DraggableItem key="videoCondition" type="videoCondition" label={NODE_TYPE_REGISTRY.videoCondition.label!} description={NODE_TYPE_REGISTRY.videoCondition.description!} color="border-secondary bg-secondary/30" icon="👁️" />,
    });
  }

  return (
    <TooltipProvider>
      <aside className="w-60 border-r border-border bg-background p-4 overflow-y-auto">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Triggers</h3>
        <div className="grid grid-cols-2 gap-2 mb-6">{sortByOrder(triggerItems, sidebarOrder)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Actions</h3>
        <div className="grid grid-cols-2 gap-2 mb-6">{sortByOrder(actionItems, sidebarOrder)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Flow Control</h3>
        <div className="grid grid-cols-2 gap-2">{sortByOrder(flowControlItems, sidebarOrder)}</div>
      </aside>
    </TooltipProvider>
  );
}
