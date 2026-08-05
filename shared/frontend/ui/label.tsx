import { forwardRef } from "react";
import { cn } from "../lib/utils";

const Label = forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn("text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70", className)}
      {...props}
    />
  )
);
// i18n-ok: React displayName，仅用于 DevTools 调试，非用户可见文案
Label.displayName = "Label";

export { Label };
