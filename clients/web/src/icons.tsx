const paths: Record<string, string> = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  tasks: "M8 5h13 M8 12h13 M8 19h13 M3 5h.1 M3 12h.1 M3 19h.1",
  rules: "M4 3h6v6H4z M14 15h6v6h-6z M7 9v7a2 2 0 0 0 2 2h5 M10 6h5a2 2 0 0 1 2 2v7",
  agents: "M5 7h14v12H5z M9 12h.1 M15 12h.1 M9 16h6 M12 3v4 M2 11v4 M22 11v4",
  cards: "M12 2l8 4v6c0 5-5 8-8 10-3-2-8-5-8-10V6z M8 12l3 3 5-6",
  delivery: "M6 4a2 2 0 1 0 .1 0 M6 8v9 M6 17a2 2 0 1 0 .1 0 M18 4a2 2 0 1 0 .1 0 M18 8c0 5-3 6-12 6",
  logs: "M3 4h18v16H3z M6 9l3 3-3 3 M12 15h5",
  settings: "M3 7h7m4 0h7 M3 17h12m4 0h2 M10 4h4v6h-4z M15 14h4v6h-4z",
  refresh: "M20 11a8 8 0 1 0-2 7 M20 4v6h-6",
  plus: "M12 5v14 M5 12h14",
  hub: "M3 4h18v6H3z M3 14h18v6H3z M6 7h.1 M6 17h.1",
  pulse: "M2 12h5l3-8 4 16 3-8h5",
  clock: "M12 3a9 9 0 1 0 .1 0 M12 7v5l3 2",
  check: "M4 12l5 5L20 6",
  menu: "M3 6h18 M3 12h18 M3 18h18",
};
export function Icon({ name }: { name: string }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Logo() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <rect width="36" height="36" rx="10" fill="#51e0bd" />
      <g stroke="#123831" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m7 22 7-12h6l-7 12H7Z M16 26l7-12h6l-7 12h-6Z" />
      </g>
    </svg>
  );
}
