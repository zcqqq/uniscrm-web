import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { PageHeader } from "../../../shared/frontend/components/PageHeader";
import { FormField } from "../../../shared/frontend/components/FormField";
import { Input } from "../../../shared/frontend/ui/input";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import { Button } from "../../../shared/frontend/ui/button";
import { useT } from "../../../shared/frontend/hooks/useT";

export function SegmentCreate() {
  const T = useT();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [nlQuery, setNlQuery] = useState("");
  const [preview, setPreview] = useState<{ conditions: unknown; sql_query: string; estimated_count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handlePreview = async () => {
    if (!nlQuery.trim()) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const result = await api.preview(nlQuery);
      setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : T({ en: "Preview failed", zh: "预览失败" }));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !nlQuery.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { segment } = await api.createSegment(name, nlQuery);
      navigate(`/segments/${segment.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : T({ en: "Create failed", zh: "创建失败" }));
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-8">
      <PageHeader title={T({ en: "Create Segment", zh: "新建分群" })} />

      <div className="space-y-4">
        <FormField label={T({ en: "Name", zh: "名称" })}>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 蓝V高粉丝近7天关注"
          />
        </FormField>

        <FormField label={T({ en: "Condition (natural language)", zh: "条件（自然语言）" })}>
          <Textarea
            value={nlQuery}
            onChange={(e) => setNlQuery(e.target.value)}
            placeholder="e.g. 过去7天内关注我、且粉丝数大于100的蓝V"
            rows={3}
          />
        </FormField>

        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={handlePreview}
            disabled={loading || !nlQuery.trim()}
          >
            {T({ en: "Preview", zh: "预览" })}
          </Button>
          <Button
            variant="default"
            onClick={handleCreate}
            disabled={loading || !name.trim() || !nlQuery.trim()}
          >
            {T({ en: "Create", zh: "新建" })}
          </Button>
        </div>

        {error && (
          <div className="text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3 text-sm">
            {error}
          </div>
        )}

        {preview && (
          <div className="bg-background border rounded p-4 space-y-2">
            <div className="text-sm"><strong>{T({ en: "Estimated users:", zh: "预计用户数：" })}</strong> {preview.estimated_count}</div>
            <div className="text-sm"><strong>{T({ en: "Conditions:", zh: "条件：" })}</strong></div>
            <pre className="text-xs bg-card border rounded p-2 overflow-x-auto">
              {JSON.stringify(preview.conditions, null, 2)}
            </pre>
            <div className="text-sm"><strong>SQL:</strong></div>
            <pre className="text-xs bg-card border rounded p-2 overflow-x-auto">{preview.sql_query}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
