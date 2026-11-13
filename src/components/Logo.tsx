import { useId } from "react";

/** Steerglass mark: an S drawn as a route between two nodes. */
export function Logo({ size = 24 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <path
        d="M46 13H26.5a9.5 9.5 0 0 0 0 19h11a9.5 9.5 0 0 1 0 19H18"
        fill="none"
        stroke={`url(#${id}-g)`}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="47" cy="13" r="6.5" fill="#2dd4bf" />
      <circle cx="17" cy="51" r="6.5" fill="#6366f1" />
    </svg>
  );
}
