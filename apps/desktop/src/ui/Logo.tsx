export function Logo({ size = 32 }: { size?: number }) {
  const icon = Math.round(size * 0.56);
  return (
    <div className="rounded-full bg-brand-tint flex items-center justify-center" style={{ width: size, height: size }}>
      <svg aria-hidden="true" width={icon} height={icon} viewBox="0 0 24 24" fill="none" stroke="#29abe2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
      </svg>
    </div>
  );
}
