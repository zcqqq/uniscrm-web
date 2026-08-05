import { Button } from "../../../shared/frontend/ui/button";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "../../../shared/frontend/ui/alert-dialog";
import { buttonVariants } from "../../../shared/frontend/ui/button";
import { cn } from "../../../shared/frontend/lib/utils";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

interface ConfirmOverflowProps {
  overflow: number;
  wouldDelete: { id: string; title: string; created_at: string }[];
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmOverflow({ overflow, wouldDelete, onConfirm, onCancel }: ConfirmOverflowProps) {
  const T = useT();
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{T({ en: "Item limit reached", zh: "已达数量上限" })}</AlertDialogTitle>
          <AlertDialogDescription>
            {T({
              en: `This import will exceed the 100-item limit. The ${overflow} oldest item${overflow > 1 ? "s" : ""} will be removed:`,
              zh: `本次导入将超出 100 项上限，最早的 ${overflow} 项将被移除：`,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="text-sm text-muted-foreground max-h-40 overflow-y-auto space-y-1">
          {wouldDelete.map((item) => (
            <li key={item.id} className="truncate">&bull; {item.title}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{T(C.cancel)}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {T({ en: "Continue", zh: "继续" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
