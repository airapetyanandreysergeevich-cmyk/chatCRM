import type { SVGProps } from "react";

/**
 * Свой набор иконок: один стиль, одна толщина линии, один размер сетки.
 * Рисуем сами, а не берём чужой набор — так интерфейс остаётся своим.
 */
type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="3" width="7.5" height="4.5" rx="2" />
    <rect x="13.5" y="10.5" width="7.5" height="10.5" rx="2" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
  </Icon>
);

export const IconOrders = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="5" width="19" height="11" rx="2" />
    <path d="M8.5 9.5h7M8.5 12.5h4" />
    <path d="M1.5 19h21" />
  </Icon>
);

export const IconClients = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19.5c0-3.1 2.7-5 6-5s6 1.9 6 5" />
    <path d="M16.2 5.4a3 3 0 0 1 0 5.6" />
    <path d="M17.5 14.9c2.1.5 3.5 1.9 3.5 4.1" />
  </Icon>
);

export const IconStock = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7.6 12 3.5l8.5 4.1v8.8L12 20.5 3.5 16.4z" />
    <path d="M3.5 7.6 12 11.8l8.5-4.2" />
    <path d="M12 11.8v8.7" />
  </Icon>
);

export const IconPurchases = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 3.5h2.2l2.1 10.2a1.8 1.8 0 0 0 1.8 1.4h8.1a1.8 1.8 0 0 0 1.8-1.4l1.3-6.4H6" />
    <circle cx="9.5" cy="19.5" r="1.4" />
    <circle cx="17" cy="19.5" r="1.4" />
  </Icon>
);

export const IconStaff = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="7.5" r="3.4" />
    <path d="M4.8 20.5c0-3.7 3.2-6 7.2-6s7.2 2.3 7.2 6" />
  </Icon>
);

export const IconWorkshops = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 20.5V8.2L12 3.5l8.5 4.7v12.3" />
    <path d="M2.5 20.5h19" />
    <path d="M9.5 20.5v-5h5v5" />
    <path d="M8.5 10.5h2M13.5 10.5h2" />
  </Icon>
);

export const IconApplications = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 13.5h4l1.5 2.5h7l1.5-2.5h4" />
    <path d="M3 13.5 5.6 5.2A2 2 0 0 1 7.5 3.8h9a2 2 0 0 1 1.9 1.4L21 13.5v4.7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
);

export const IconAdmins = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.2 4.8 6v6c0 4.2 3 7.5 7.2 8.8 4.2-1.3 7.2-4.6 7.2-8.8V6z" />
    <path d="m9.2 12.1 2 2 3.6-3.9" />
  </Icon>
);

export const IconJournal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 4.5h15v15h-15z" rx="2" />
    <path d="M8 9h8M8 12.5h8M8 16h5" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 4.5 4.5" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconLogout = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.5 3.5h3a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-3" />
    <path d="M10 8.5 6.5 12l3.5 3.5" />
    <path d="M6.5 12H15" />
  </Icon>
);
