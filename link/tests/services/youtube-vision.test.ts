import { describe, it, expect, vi } from "vitest";
import { detectFace } from "../../src/services/youtube-vision";

describe("detectFace", () => {
  it("returns 1 when the model detects at least one object", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ objects: [{ x: 1, y: 2 }] }) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(1);
    expect(ai.run).toHaveBeenCalledWith("@cf/moondream/moondream3.1-9B-A2B", {
      task: "detect",
      image: "https://img.example/thumb.jpg",
      target: "human face",
    });
  });

  it("returns 0 when the model detects no objects", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ objects: [] }) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(0);
  });

  it("returns 0 when objects is missing from the response", async () => {
    const ai = { run: vi.fn().mockResolvedValue({}) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(0);
  });

  it("fails closed to 1 when the model call throws", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("model unavailable")) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(1);
  });
});
