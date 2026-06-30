import { Button } from "../../../shared/frontend/ui/button";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "../../../shared/frontend/ui/alert-dialog";
import { buttonVariants } from "../../../shared/frontend/ui/button";
import { cn } from "../../../shared/frontend/lib/utils";

interface ConfirmOverflowProps {
  overflow: number;
  wouldDelete: { id: string; title: string; created_at: string }[];
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmOverflow({ overflow, wouldDelete, onConfirm, onCancel }: ConfirmOverflowProps) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Item limit reached</AlertDialogTitle>
          <AlertDialogDescription>
            This import will exceed the 100-item limit. The {overflow} oldest item{overflow > 1 ? "s" : ""} will be removed:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="text-sm text-muted-foreground max-h-40 overflow-y-auto space-y-1">
          {wouldDelete.map((item) => (
            <li key={item.id} className="truncate">&bull; {item.title}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            Continue
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
