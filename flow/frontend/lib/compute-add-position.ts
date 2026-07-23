// Same node footprint Canvas.tsx's dagre Arrange logic uses (g.setNode(n.id, { width: 200, height: 100 })),
// reused here so a tapped-to-add node doesn't land exactly on top of an existing one.
const NODE_WIDTH = 200;
const NODE_HEIGHT = 100;
const NUDGE = 40;
const MAX_NUDGES = 20;

interface PositionedNode {
  position: { x: number; y: number };
}

function collidesWithAny(pos: { x: number; y: number }, nodes: PositionedNode[]): boolean {
  return nodes.some(
    (n) => Math.abs(n.position.x - pos.x) < NODE_WIDTH && Math.abs(n.position.y - pos.y) < NODE_HEIGHT
  );
}

export function computeAddPosition(
  desired: { x: number; y: number },
  existingNodes: PositionedNode[]
): { x: number; y: number } {
  let pos = { ...desired };
  let nudges = 0;
  while (collidesWithAny(pos, existingNodes) && nudges < MAX_NUDGES) {
    pos = { x: pos.x + NUDGE, y: pos.y + NUDGE };
    nudges++;
  }
  return pos;
}
