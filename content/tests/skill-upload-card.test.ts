import { describe, it, expect } from "vitest";
import cardSource from "../frontend/components/SkillUploadCard.tsx?raw";
import settingsSource from "../frontend/pages/SettingsPage.tsx?raw";
import apiSource from "../frontend/lib/api.ts?raw";
import { grabDroppedEntries, readDirectory } from "../frontend/components/SkillUploadCard";

describe("SkillUploadCard 接线", () => {
  it("用共享的拆包函数，不自己再造一个解析器", () => {
    expect(cardSource).toContain('from "../lib/skill-package"');
    expect(cardSource).toContain("parseSkillFiles");
    expect(cardSource).toContain("unzipToEntries");
  });

  it("三种入口都接上：zip、文件夹、单文件", () => {
    expect(cardSource).toContain("webkitdirectory");
    expect(cardSource).toContain(".zip");
    expect(cardSource).toContain("onDrop");
  });

  // 重名必须先问用户。静默覆盖会让用户丢掉自己写的技能。
  it("重名有覆盖/改名两条出路，且不静默覆盖", () => {
    expect(cardSource).toContain("conflict");
    expect(cardSource).toContain('{ en: "Overwrite", zh: "覆盖" }');
    expect(cardSource).toContain('{ en: "Rename", zh: "改名" }');
  });

  it("文案双语", () => {
    for (const s of ['{ en: "My skills", zh: "我的技能" }',
                     '{ en: "Drag & drop a .zip, a folder, or a SKILL.md", zh: "拖入 .zip、文件夹或 SKILL.md" }']) {
      expect(cardSource).toContain(s);
    }
  });

  it("api client 有导入、列出与删除", () => {
    expect(apiSource).toContain("skills:");
    expect(apiSource).toContain("/api/skills/import");
  });

  it("卡片挂进了设置页", () => {
    expect(settingsSource).toContain("SkillUploadCard");
  });

  // review finding 1: 409（两个标签页/过期列表）必须能恢复——不重新拉取 existing 的话，
  // isConflict 还是用旧数据算，冲突行永远不会亮起来，Overwrite 按钮也就永远出不来，
  // 用户唯一的路只剩"盲改名字再赌一次"，"两条出路"的承诺就碎在这个分支里。
  it("409 时重新拉取技能列表，让过期导致的冲突行重新亮起", () => {
    const catchStart = cardSource.indexOf("} catch (e");
    const catchEnd = cardSource.indexOf("} finally", catchStart);
    expect(catchStart).toBeGreaterThan(-1);
    const catchBlock = cardSource.slice(catchStart, catchEnd);
    // 409 分支内必须调用 reload（不是只在 try 的成功路径里调用一次就完事）——
    // 让 isConflict 用最新的 existing 重新算一遍，冲突行才会亮起来。
    expect(catchBlock).toMatch(/status === 409[\s\S]*?reload\(\)/);
  });

  // review finding 2: overwrite 状态曾经按可编辑的 name 记（Record<name, boolean>）。两行
  // 撞了同一个 name（两个技能文件夹的 frontmatter 都写 name: "Foo"）时，点第一行的"覆盖"
  // 会通过共享的 key 连带解锁第二行——用户只确认了一行，两行的 payload 却都带 overwrite:
  // true 发出去。必须按 ingest 时钉住的稳定 rowId 记，不能再用 name 当 key。
  it("overwrite 状态按行的稳定 id 记，不按可编辑的 name 记（两行重名时互不牵连）", () => {
    expect(cardSource).not.toContain("overwrite[s.name]");
    expect(cardSource).not.toContain("[s.name]: !o[s.name]");
    expect(cardSource).toContain("overwrite[s.rowId]");
    expect(cardSource).toContain("[s.rowId]: !o[s.rowId]");
    // rowId 要在 ingest（parseSkillFiles 之后）一次性分配，且不能用 name 本身当 rowId——
    // 否则又变相退化回按 name 记。
    expect(cardSource).toMatch(/rowId:\s*`r\$\{nextRowId\.current\+\+\}`/);
  });

  // review finding 3 (final review, Important 3): 409 恢复不能再靠"重新拉取列表 + 按 label
  // 比对"——label 与后端 slug 不是同一个等价关系时，isConflict 永远不亮，Overwrite 按钮永远
  // 出不来，Import 一直可点，点了又是同一个 409，用户唯一出路是"盲改名字再赌一次"。改成直接
  // 吃响应体 conflicts 里带的、提交时的原始 name，精确映射回行。
  it("409 恢复读响应体的 conflicts（skillId + name），不再靠 isConflict/label 重新推导", () => {
    // 定位到 confirm() 内部的 catch —— cardSource.indexOf("} catch (e") 会先撞上更早出现的
    // ingest() 的 "} catch (e) {"，所以必须先锚定到 confirm 函数体，再在它内部找 catch。
    const confirmStart = cardSource.indexOf("const confirm = async");
    expect(confirmStart).toBeGreaterThan(-1);
    const catchStart = cardSource.indexOf("} catch (e", confirmStart);
    const catchEnd = cardSource.indexOf("} finally", catchStart);
    expect(catchStart).toBeGreaterThan(confirmStart);
    const catchBlock = cardSource.slice(catchStart, catchEnd);
    expect(catchBlock).toContain("e.body?.conflicts");
    expect(catchBlock).toContain("rowIdByName");
    // 不能再把"重新算 isConflict"当成 409 分支唯一的恢复手段——响应体本身才是权威来源。
    expect(catchBlock).not.toMatch(/isConflict\(/);
  });

  // review finding 4 (final review, Minor): 非 409 的失败此前一律显示写死的 "Import failed"，
  // 把服务端具体原因（400 emoji 名字/超限/批内碰撞……）吞掉了，用户和排障者都两眼一抹黑。
  it("非 409 的导入失败带上服务端的具体原因，不再一律吞成 Import failed", () => {
    const confirmStart = cardSource.indexOf("const confirm = async");
    const catchStart = cardSource.indexOf("} catch (e", confirmStart);
    const catchEnd = cardSource.indexOf("} finally", catchStart);
    const catchBlock = cardSource.slice(catchStart, catchEnd);
    const elseStart = catchBlock.lastIndexOf("} else {");
    expect(elseStart).toBeGreaterThan(-1);
    expect(catchBlock.slice(elseStart)).toContain("e?.message");
  });
});

// review finding 5 (final review, Important 2): handleDrop 里 webkitGetAsEntry()/getAsFile()
// 曾经写在一个 for...of 循环里、每轮先 await readDirectory() 再进入下一轮——DataTransfer 的
// 数据存储只在事件同步派发期间可读，第二个及之后的条目在真实浏览器里会静默拿到 null（两个
// 文件夹一起拖入时，第二个直接消失，界面毫无signal）。grabDroppedEntries 把"读取"从"处理"
// 里拆出来，做成一个不含 await 的纯函数，让"必须同步读完"这条不变量在类型和运行时层面都
// 不可违反，而不是只能读代码肉眼确认。
describe("grabDroppedEntries — 必须在任何 await 之前同步读完每一项", () => {
  it("是纯同步函数：对传入的每一项都会调用 webkitGetAsEntry/getAsFile，返回值不是 Promise", () => {
    let entryCalls = 0;
    let fileCalls = 0;
    const items = [
      { kind: "file", webkitGetAsEntry: () => { entryCalls++; return { isDirectory: true, tag: "dir1" }; }, getAsFile: () => { fileCalls++; return null; } },
      { kind: "file", webkitGetAsEntry: () => { entryCalls++; return null; }, getAsFile: () => { fileCalls++; return { name: "b.md" } as unknown as File; } },
    ];
    const grabbed = grabDroppedEntries(items);
    // 函数返回时（还没有任何 await 发生）两项就都已经被同步读取——这是本回归要钉住的核心。
    expect(grabbed).not.toBeInstanceOf(Promise);
    expect(entryCalls).toBe(2);
    expect(fileCalls).toBe(2);
    expect(grabbed).toEqual([
      { entry: { isDirectory: true, tag: "dir1" }, file: null },
      { entry: null, file: { name: "b.md" } },
    ]);
  });

  it("item.kind 不是 'file' 时不取 getAsFile（比如拖入的是纯文本，不是文件）", () => {
    const items = [{ kind: "string", webkitGetAsEntry: () => null, getAsFile: () => { throw new Error("should not be called"); } }];
    expect(() => grabDroppedEntries(items)).not.toThrow();
    expect(grabDroppedEntries(items)).toEqual([{ entry: null, file: null }]);
  });
});

describe("readDirectory — 必须翻页读完整个目录，且错误回调要真的传上去", () => {
  function fakeFileEntry(name: string) {
    return { isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok({ name } as unknown as File) };
  }
  function fakeReaderYielding(batches: unknown[][]) {
    let call = 0;
    return { createReader: () => ({ readEntries: (ok: (b: unknown[]) => void) => ok(batches[call++] ?? []) }) };
  }

  // Chrome 的 readEntries 一次最多返回 100 条；这里只用 3 条模拟"分好几批"，重点不是凑够
  // 100，是验证"批 1 非空 → 继续要下一批 → 批 2 非空 → 继续 → 批 3 空 → 停"这条循环逻辑，
  // 而不是像修复前那样只 await 一次就把后面几批全部丢弃。
  it("readEntries 返回非空批次时必须继续调用，直到收到空数组为止", async () => {
    const batch1 = [fakeFileEntry("a.md")];
    const batch2 = [fakeFileEntry("b.md")]; // 只调一次 readEntries 的旧实现会把这批丢掉
    const entry = fakeReaderYielding([batch1, batch2, []]);

    const files = await readDirectory(entry);

    expect(files.map((f) => f.name).sort()).toEqual(["a.md", "b.md"]);
  });

  it("readEntries 的错误回调被真正接上——失败时 promise reject，不是永久 pending", async () => {
    const entry = {
      createReader: () => ({
        readEntries: (_ok: (b: unknown[]) => void, err: (e: unknown) => void) => err(new Error("boom")),
      }),
    };

    await expect(readDirectory(entry)).rejects.toThrow("boom");
  });

  it("entry.file() 的错误回调也接上——单个文件读取失败同样 reject 而不是卡死", async () => {
    const entry = fakeReaderYielding([[
      { isFile: true, isDirectory: false, file: (_ok: (f: File) => void, err: (e: unknown) => void) => err(new Error("read failed")) },
    ]]);

    await expect(readDirectory(entry)).rejects.toThrow("read failed");
  });
});
