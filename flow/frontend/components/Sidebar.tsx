import { CHANNEL_TYPES } from "../config/trigger-fields";

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
    <div
      draggable
      onDragStart={onDragStart}
      className={`p-3 rounded-lg border cursor-grab active:cursor-grabbing hover:shadow-sm transition-shadow ${color}`}
    >
      <div className="flex items-center gap-2">
        <span>{icon}</span>
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">{description}</p>
    </div>
  );
}

export default function Sidebar() {
  return (
    <aside className="w-60 border-r border-border bg-background p-4 overflow-y-auto">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Triggers</h3>
      <div className="space-y-2 mb-6">
        {CHANNEL_TYPES.map((ct) => (
          <DraggableItem
            key={ct.channelType}
            type="xTrigger"
            label={`${ct.label} Trigger`}
            description={`${ct.events.length} events`}
            color="border-primary/30 bg-primary/5"
            icon={ct.icon}
          />
        ))}
      </div>

      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Flow Control</h3>
      <div className="space-y-2 mb-6">
        <DraggableItem
          type="waitForEvent"
          label="Wait for Event"
          description="Check if event has occurred"
          color="border-secondary bg-secondary/30"
          icon="🔍"
        />
        <DraggableItem
          type="wait"
          label="Wait"
          description="Delay for a specified duration"
          color="border-secondary bg-secondary/30"
          icon="⏳"
        />
      </div>

      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Actions</h3>
      <div className="space-y-2">
        <DraggableItem
          type="addToList"
          label="Add to List"
          description="Add user to a profile list"
          color="border-accent bg-accent/50"
          icon="📋"
        />
        <DraggableItem
          type="xAction"
          label="X Action"
          description="Follow or unfollow user on X"
          color="border-accent bg-accent/50"
          icon="𝕏"
        />
      </div>
    </aside>
  );
}
