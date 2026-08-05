import { ArrowUpCircle } from "lucide-react";
import { useT } from "./hooks/useT";

interface UpgradeIconProps {
  webUrl: string;
  className?: string;
}

export function UpgradeIcon({ webUrl, className = "" }: UpgradeIconProps) {
  const T = useT();
  return (
    <a
      href={`${webUrl}/billing`}
      title={T({ en: "Upgrade to unlock", zh: "升级以解锁" })}
      className={`inline-flex items-center justify-center text-violet-500 hover:text-violet-600 dark:text-violet-400 dark:hover:text-violet-300 ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      <ArrowUpCircle className="w-3.5 h-3.5" />
    </a>
  );
}
