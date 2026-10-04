/** Perseverance "P" monogram (accent). */
export function LogoMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="shell-logo-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b3a8ff" />
          <stop offset="1" stopColor="#7a68f0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="#1d1a2e" stroke="rgba(139,124,246,0.45)" strokeWidth="1" />
      {/* Stylized P: a stem with a slanted cut + a bowl */}
      <path
        d="M8.2 18.4V6.6c0-.5.4-.9.9-.9h4.3c2.6 0 4.4 1.7 4.4 4.1s-1.8 4.1-4.4 4.1h-2.3v3.6c0 .4-.2.6-.5.8l-1.6.9c-.4.2-.8 0-.8-.8Zm2.9-6.9h2.1c1.1 0 1.8-.7 1.8-1.7s-.7-1.7-1.8-1.7h-2.1v3.4Z"
        fill="url(#shell-logo-grad)"
      />
    </svg>
  );
}

/** Large brand mark for the start screen / about dialog. */
export function LogoLarge({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="shell-logo-lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c2b9ff" />
          <stop offset="0.55" stopColor="#8b7cf6" />
          <stop offset="1" stopColor="#5d4bd6" />
        </linearGradient>
        <radialGradient id="shell-logo-glow" cx="0.3" cy="0.2" r="0.9">
          <stop offset="0" stopColor="rgba(139,124,246,0.35)" />
          <stop offset="1" stopColor="rgba(139,124,246,0)" />
        </radialGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#17142a" />
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#shell-logo-glow)" />
      <rect x="2.5" y="2.5" width="59" height="59" rx="15.5" fill="none" stroke="rgba(165,151,255,0.35)" />
      <path
        d="M21.9 49V17.6c0-1.3 1-2.4 2.4-2.4h11.5c7 0 11.8 4.5 11.8 11s-4.8 11-11.8 11h-6.1v9.5c0 1-.5 1.7-1.3 2.1l-4.3 2.4c-1.1.6-2.2-.1-2.2-2.2Zm7.8-18.4h5.6c3 0 4.9-1.8 4.9-4.5s-1.9-4.5-4.9-4.5h-5.6v9Z"
        fill="url(#shell-logo-lg)"
      />
    </svg>
  );
}
