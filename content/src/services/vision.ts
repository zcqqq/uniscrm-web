export async function detectFace(ai: Ai, imageUrl: string): Promise<boolean> {
  const response = (await ai.run("@cf/moondream/moondream3.1-9B-A2B", {
    task: "detect",
    image: imageUrl,
    target: "human face",
  })) as { objects?: unknown[] };
  return Array.isArray(response.objects) && response.objects.length > 0;
}
