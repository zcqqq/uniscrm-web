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
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className="text-xs text-gray-500 mt-1">{description}</p>
    </div>
  );
}

export default function Sidebar() {
  return (
    <aside className="w-60 border-r border-gray-200 bg-white p-4 overflow-y-auto">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Triggers</h3>
      <div className="space-y-2 mb-6">
        {CHANNEL_TYPES.map((ct) => (
          <DraggableItem
            key={ct.channelType}
            type={`trigger:${ct.channelType}`}
            label={ct.label}
            description={`${ct.events.length} events`}
            color="border-purple-200 bg-purple-50/50"
            icon={ct.icon}
          />
        ))}
      </div>

      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Conditions</h3>
      <div className="space-y-2 mb-6">
        <DraggableItem
          type="condition"
          label="Event Props"
          description="Filter based on event fields"
          color="border-amber-200 bg-amber-50/50"
          icon="🔀"
        />
        <DraggableItem
          type="eventHistory"
          label="Wait for Event"
          description="Check if event has occurred"
          color="border-indigo-200 bg-indigo-50/50"
          icon="🔍"
        />
        <DraggableItem
          type="wait"
          label="Wait"
          description="Delay for a specified duration"
          color="border-sky-200 bg-sky-50/50"
          icon="⏳"
        />
      </div>

      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Actions</h3>
      <div className="space-y-2">
        <DraggableItem
          type="addPoint"
          label="Add Point"
          description="Increment user point by 1"
          color="border-green-200 bg-green-50/50"
          icon="🎯"
        />
        <DraggableItem
          type="addToList"
          label="Add to List"
          description="Add user to a profile list"
          color="border-green-200 bg-green-50/50"
          icon="📋"
        />
        <DraggableItem
          type="xAction"
          label="X Action"
          description="Follow or unfollow user on X"
          color="border-green-200 bg-green-50/50"
          icon="𝕏"
        />
      </div>
    </aside>
  );
}
