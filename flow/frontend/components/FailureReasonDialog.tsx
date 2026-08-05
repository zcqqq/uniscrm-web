import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../shared/frontend/ui/dialog";
import { useT } from "../../../shared/frontend/hooks/useT";

interface FailureReasonDialogProps {
  /** Machine-stable code, optionally followed by ": " and the external API's own error text. */
  reason?: string | null;
  /** What failed — the node name, shown as the dialog title so the reason has context. */
  nodeName: string;
  /** Which user/content item this failure belongs to. */
  subject?: string | null;
}

/**
 * The red "Failed" marker in the analytics drawer. Clickable whenever a reason was recorded;
 * plain text otherwise (rows written before failure_reason existed, and any failure path that
 * genuinely has nothing to report).
 */
export function FailureReasonDialog({ reason, nodeName, subject }: FailureReasonDialogProps) {
  const T = useT();
  const [open, setOpen] = useState(false);

  if (!reason) return <p className="text-destructive font-medium">{T({ en: "Failed", zh: "失败" })}</p>;

  // "code: detail" — split on the FIRST colon only, so a detail containing colons (URLs, X's
  // own messages) stays intact.
  const separator = reason.indexOf(":");
  const code = separator === -1 ? reason : reason.slice(0, separator);
  const detail = separator === -1 ? null : reason.slice(separator + 1).trim();

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="text-destructive font-medium underline underline-offset-2 hover:no-underline"
      >
        {T({ en: "Failed", zh: "失败" })}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{T({ en: `${nodeName} failed`, zh: `${nodeName} 失败` })}</DialogTitle>
            {subject && <DialogDescription className="break-all">{subject}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{T({ en: "Reason", zh: "原因" })}</p>
            <p className="text-sm font-mono text-destructive break-all">{code}</p>
            {detail && <p className="text-sm text-foreground break-words whitespace-pre-wrap">{detail}</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
