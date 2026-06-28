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
      <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
        <path d="M2.5 12.5l2-5 3.5 2 2-6 3.5 5-2.5 4h-8.5z" opacity="0.2"/>
        <path d="M8 1l2.163 4.382L15 6.236l-3.5 3.412.826 4.816L8 12.236l-4.326 2.228.826-4.816L1 6.236l4.837-.854L8 1z" strokeWidth="1" stroke="currentColor" fill="none"/>
      </svg>
    </a>
  );
}
