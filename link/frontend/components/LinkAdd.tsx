import { useState } from "react";
import { api } from "../lib/api";
import type { OverflowInfo } from "../lib/api";
import { ConfirmOverflow } from "./ConfirmOverflow";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

interface Props {
  onAdded: () => void;
}

export function LinkAdd({ onAdded }: Props) {
  const T = useT();
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [overflowInfo, setOverflowInfo] = useState<OverflowInfo | null>(null);

  const handleSubmit = async (confirmed?: boolean) => {
    if (!title.trim() || !url.trim()) return;
    setAdding(true);
    try {
      const result = await api.link.add(title.trim(), url.trim(), confirmed);
      if ("needsConfirmation" in result) {
        setOverflowInfo(result);
      } else {
        setTitle("");
        setUrl("");
        setShowForm(false);
        setOverflowInfo(null);
        onAdded();
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <Card className="border-2 border-dashed">
        <CardContent className="p-6 text-center">
          <div className="text-sm font-medium text-foreground mb-2">{T({ en: "Link", zh: "链接" })}</div>
          <p className="text-muted-foreground text-sm mb-3">{T({ en: "Add product by URL", zh: "通过 URL 添加商品" })}</p>

          {showForm ? (
            <div className="text-left space-y-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={T({ en: "Product name", zh: "商品名称" })}
              />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://..."
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => handleSubmit()}
                  disabled={adding || !title.trim() || !url.trim()}
                >
                  {adding ? T({ en: "Adding...", zh: "添加中…" }) : T(C.add)}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setShowForm(false); setTitle(""); setUrl(""); setOverflowInfo(null); }}
                >
                  {T(C.cancel)}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" onClick={() => setShowForm(true)}>
              + {T({ en: "Add Link", zh: "添加链接" })}
            </Button>
          )}
        </CardContent>
      </Card>

      {overflowInfo && (
        <ConfirmOverflow
          overflow={overflowInfo.overflow}
          wouldDelete={overflowInfo.wouldDelete}
          onConfirm={() => handleSubmit(true)}
          onCancel={() => setOverflowInfo(null)}
        />
      )}
    </>
  );
}
