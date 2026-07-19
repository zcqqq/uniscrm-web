import { describe, it, expect, vi } from "vitest";
import { detectFace } from "../src/services/vision";

describe("detectFace", () => {
  it("returns true when the model detects at least one object", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ objects: [{ x: 1, y: 2 }] }) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(true);
    expect(ai.run).toHaveBeenCalledWith("@cf/moondream/moondream3.1-9B-A2B", {
      task: "detect",
      image: "https://img.example/thumb.jpg",
      target: "human face",
    });
  });

  it("returns false when the model detects no objects", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ objects: [] }) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(false);
  });

  it("returns false when objects is missing from the response", async () => {
    const ai = { run: vi.fn().mockResolvedValue({}) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(false);
  });

  it("propagates the error when the model call throws (no fail-open/fail-closed default)", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("model unavailable")) };
    await expect(detectFace(ai as any, "https://img.example/thumb.jpg")).rejects.toThrow("model unavailable");
  });
});
