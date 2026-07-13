import { ArrowUpCircle } from "lucide-react";

interface UpgradeIconProps {
  webUrl: string;
  className?: string;
}

export function UpgradeIcon({ webUrl, className = "" }: UpgradeIconProps) {
  return (
    <a
      href={`${webUrl}/billing`}
      title="Upgrade to unlock"
      className={`inline-flex items-center justify-center text-violet-500 hover:text-violet-600 dark:text-violet-400 dark:hover:text-violet-300 ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      <ArrowUpCircle className="w-3.5 h-3.5" />
    </a>
  );
}
