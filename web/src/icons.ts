// Lucide icons rendered as inline SVG strings, for use in the template-string
// markup the UI builds. Only icons imported here end up in the bundle.

import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Bookmark,
  ChartColumn,
  ChevronDown,
  ChevronUp,
  Clock,
  Combine,
  Cpu,
  Database,
  Download,
  FileText,
  FileUp,
  FilterX,
  Folder,
  FolderOpen,
  FolderUp,
  Globe,
  ListEnd,
  Menu,
  Palette,
  Pin,
  Puzzle,
  Radio,
  Save,
  Search,
  Tag,
  Trash2,
  X,
  type IconNode,
} from 'lucide';

export const ICONS = {
  arrowDown: ArrowDown,
  arrowUp: ArrowUp,
  bookmark: Bookmark,
  bottom: ArrowDownToLine,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  clock: Clock,
  database: Database,
  close: X,
  delete: Trash2,
  dirUp: FolderUp,
  download: Download,
  file: FileText,
  filterClear: FilterX,
  folder: Folder,
  globe: Globe,
  follow: ListEnd,
  load: FileUp,
  menu: Menu,
  merge: Combine,
  open: FolderOpen,
  palette: Palette,
  part: Puzzle,
  pin: Pin,
  report: ChartColumn,
  save: Save,
  search: Search,
  stream: Radio,
  tag: Tag,
  thread: Cpu,
  top: ArrowUpToLine,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

// The log-viewer mark, inlined so it renders crisply and also works inside the
// <log-viewer> shadow DOM, where relative asset URLs would resolve against the
// host page. Vector redraw of docs/logo.png. Below 32px it switches to the
// bolder geometry of public/favicon.svg, which drops the faded line.
const LOGO_FULL =
  `viewBox="68 92 882 882"><polyline points="165,395 283,530 165,664" stroke="#4f46e5" stroke-width="74"/>` +
  `<line x1="362" y1="390" x2="757" y2="390" stroke="#0f172a" stroke-width="66"/>` +
  `<line x1="388" y1="487" x2="698" y2="487" stroke="#f59e0b" stroke-width="60"/>` +
  `<line x1="381" y1="593" x2="625" y2="593" stroke="#4f46e5" stroke-width="54"/>` +
  `<line x1="339" y1="686" x2="522" y2="686" stroke="#4f46e5" stroke-width="54" opacity="0.45"/>` +
  `<circle cx="849" cy="392" r="41" fill="#ef4444"/>`;
const LOGO_SMALL =
  `viewBox="0 0 32 32"><polyline points="3.5,9.5 9,16 3.5,22.5" stroke="#4f46e5" stroke-width="3.6"/>` +
  `<line x1="13" y1="9.5" x2="24" y2="9.5" stroke="#0f172a" stroke-width="3.4"/>` +
  `<line x1="13" y1="16" x2="22" y2="16" stroke="#f59e0b" stroke-width="3.4"/>` +
  `<line x1="13" y1="22.5" x2="19.5" y2="22.5" stroke="#4f46e5" stroke-width="3.4"/>` +
  `<circle cx="28.5" cy="9.5" r="2.4" fill="#ef4444"/>`;

export function logoMark(size = 20): string {
  return (
    `<svg class="logo-mark" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${size < 32 ? LOGO_SMALL : LOGO_FULL}</svg>`
  );
}

export function icon(name: IconName, size = 16): string {
  const body = ICONS[name].map(([tag, attrs]) => {
    const a = Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    return `<${tag} ${a}/>`;
  });
  return (
    `<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${body.join('')}</svg>`
  );
}
