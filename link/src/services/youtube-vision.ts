// Workers AI has no dedicated face-detection model — @cf/moondream/moondream3.1-9B-A2B's
// "detect" task returns bounding boxes for a target phrase, used here as the closest available
// primitive. On any model error, fails closed (assumes a face is present) per the design's
// explicit v1 decision — a detection outage should never silently let a face-containing
// thumbnail through a "no face" flow condition.
export async function detectFace(ai: Ai, imageUrl: string): Promise<0 | 1> {
  try {
    const response = (await ai.run("@cf/moondream/moondream3.1-9B-A2B", {
      task: "detect",
      image: imageUrl,
      target: "human face",
    })) as { objects?: unknown[] };
    return Array.isArray(response.objects) && response.objects.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(JSON.stringify({ event: "youtube_face_detect_error", error: String(e) }));
    return 1;
  }
}
