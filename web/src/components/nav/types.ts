export interface NavItem {
  id: string;
  label: string;
  shortcut: string;
  icon: string;
  to: string | { name: string };
  activePatterns: string[];
}
