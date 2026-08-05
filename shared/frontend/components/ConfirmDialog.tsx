import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../ui/alert-dialog";
import { buttonVariants } from "../ui/button";
import { cn } from "../lib/utils";
import { useT } from "../hooks/useT";
import { C } from "../i18n-common";
import type { LocalizedString } from "../../../metadata/dataTypes";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: LocalizedString;
  cancelLabel?: LocalizedString;
  variant?: "default" | "destructive";
}

export function ConfirmDialog({
  open, onOpenChange, onConfirm, title, description,
  confirmLabel = C.confirm, cancelLabel = C.cancel, variant = "default",
}: ConfirmDialogProps) {
  const T = useT();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{T(cancelLabel)}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(variant === "destructive" && buttonVariants({ variant: "destructive" }))}
          >
            {T(confirmLabel)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
