import { useFlowEditor } from "../store/flow-editor";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import { NODE_TYPE_REGISTRY, type FlowDomain } from "../../nodeTypeRegistry";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../../shared/frontend/ui/tooltip";

interface DraggableItemProps {
  type: string;
  label: string;
  description: string;
  color: string;
  icon: string;
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

// Declaration order in NODE_TYPE_REGISTRY is the single source of truth for Sidebar item
// order within each section — sort each section's items by their registry key's index so a
// future reorder of the registry doesn't require a second, manually-synced edit here.
const REGISTRY_ORDER = Object.keys(NODE_TYPE_REGISTRY);

interface SectionItem {
  key: string;
  el: React.ReactNode;
}

function sortByRegistryOrder(items: SectionItem[]): React.ReactNode[] {
  return [...items]
    .sort((a, b) => REGISTRY_ORDER.indexOf(a.key) - REGISTRY_ORDER.indexOf(b.key))
    .map((i) => i.el);
}

export default function Sidebar() {
  const nodes = useFlowEditor((s) => s.nodes);
  const domain: FlowDomain = nodes.some((n) => n.type === "xContentTrigger") ? "content" : "user";
  const visible = (nodeTypeKey: string) => {
    const cfg = NODE_TYPE_REGISTRY[nodeTypeKey];
    return !cfg || cfg.domain === "both" || cfg.domain === domain;
  };
  const xChannel = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!;

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
            icon={ct.icon}
          />
        ),
      });
    }
  }
  if (visible("cronTrigger")) {
    triggerItems.push({
      key: "cronTrigger",
      el: <DraggableItem key="cronTrigger" type="cronTrigger" label={NODE_TYPE_REGISTRY.cronTrigger.label!} description="Trigger on a schedule" color="border-primary/30 bg-primary/5" icon="⏰" />,
    });
  }
  if (visible("xContentTrigger")) {
    triggerItems.push({
      key: "xContentTrigger",
      el: <DraggableItem key="xContentTrigger" type="xContentTrigger" label={NODE_TYPE_REGISTRY.xContentTrigger.label!} description={NODE_TYPE_REGISTRY.xContentTrigger.description!} color="border-primary/30 bg-primary/5" icon="𝕏" />,
    });
  }

  const actionItems: SectionItem[] = [];
  if (visible("addToList")) {
    actionItems.push({
      key: "addToList",
      el: <DraggableItem key="addToList" type="addToList" label={NODE_TYPE_REGISTRY.addToList.label!} description="Add user to a profile list" color="border-accent bg-accent/50" icon="📋" />,
    });
  }
  if (visible("xAction")) {
    actionItems.push({
      key: "xAction",
      el: <DraggableItem key="xAction" type="xAction" label={NODE_TYPE_REGISTRY.xAction.label!} description={`${xChannel.actions.length} actions`} color="border-accent bg-accent/50" icon="𝕏" />,
    });
  }
  if (visible("webhook")) {
    actionItems.push({
      key: "webhook",
      el: <DraggableItem key="webhook" type="webhook" label={NODE_TYPE_REGISTRY.webhook.label!} description="Send HTTP request" color="border-accent bg-accent/50" icon="🔗" />,
    });
  }
  if (visible("changeUserProps")) {
    actionItems.push({
      key: "changeUserProps",
      el: <DraggableItem key="changeUserProps" type="changeUserProps" label={NODE_TYPE_REGISTRY.changeUserProps.label!} description="Update user properties" color="border-accent bg-accent/50" icon="✏️" />,
    });
  }
  if (visible("xContentAction")) {
    actionItems.push({
      key: "xContentAction",
      el: <DraggableItem key="xContentAction" type="xContentAction" label={NODE_TYPE_REGISTRY.xContentAction.label!} description={NODE_TYPE_REGISTRY.xContentAction.description!} color="border-accent bg-accent/50" icon="✨" />,
    });
  }
  if (visible("tiktokContentAction")) {
    actionItems.push({
      key: "tiktokContentAction",
      el: <DraggableItem key="tiktokContentAction" type="tiktokContentAction" label={NODE_TYPE_REGISTRY.tiktokContentAction.label!} description="Generate images + caption and send to TikTok as a draft" color="border-accent bg-accent/50" icon="📸" />,
    });
  }
  if (visible("updateContentStatus")) {
    actionItems.push({
      key: "updateContentStatus",
      el: <DraggableItem key="updateContentStatus" type="updateContentStatus" label={NODE_TYPE_REGISTRY.updateContentStatus.label!} description="Set this content's status" color="border-accent bg-accent/50" icon="🏷️" />,
    });
  }

  const flowControlItems: SectionItem[] = [];
  if (visible("waitForEvent")) {
    flowControlItems.push({
      key: "waitForEvent",
      el: <DraggableItem key="waitForEvent" type="waitForEvent" label={NODE_TYPE_REGISTRY.waitForEvent.label!} description="Check if event has occurred" color="border-secondary bg-secondary/30" icon="🔍" />,
    });
  }
  if (visible("wait")) {
    flowControlItems.push({
      key: "wait",
      el: <DraggableItem key="wait" type="wait" label={NODE_TYPE_REGISTRY.wait.label!} description="Delay for a specified duration" color="border-secondary bg-secondary/30" icon="⏳" />,
    });
  }
  if (visible("timeCondition")) {
    flowControlItems.push({
      key: "timeCondition",
      el: <DraggableItem key="timeCondition" type="timeCondition" label={NODE_TYPE_REGISTRY.timeCondition.label!} description="Gate by time-of-day / day-of-week" color="border-secondary bg-secondary/30" icon="🕐" />,
    });
  }
  if (visible("userPropsCondition")) {
    flowControlItems.push({
      key: "userPropsCondition",
      el: <DraggableItem key="userPropsCondition" type="userPropsCondition" label={NODE_TYPE_REGISTRY.userPropsCondition.label!} description="Branch by user properties" color="border-secondary bg-secondary/30" icon="👤" />,
    });
  }
  if (visible("abSplit")) {
    flowControlItems.push({
      key: "abSplit",
      el: <DraggableItem key="abSplit" type="abSplit" label={NODE_TYPE_REGISTRY.abSplit.label!} description="Split traffic by % or condition" color="border-secondary bg-secondary/30" icon="⚡" />,
    });
  }

  return (
    <TooltipProvider>
      <aside className="w-60 border-r border-border bg-background p-4 overflow-y-auto">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Triggers</h3>
        <div className="grid grid-cols-2 gap-2 mb-6">{sortByRegistryOrder(triggerItems)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Actions</h3>
        <div className="grid grid-cols-2 gap-2 mb-6">{sortByRegistryOrder(actionItems)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Flow Control</h3>
        <div className="grid grid-cols-2 gap-2">{sortByRegistryOrder(flowControlItems)}</div>
      </aside>
    </TooltipProvider>
  );
}
