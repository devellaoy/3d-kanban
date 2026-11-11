// The office's icons: Lucide's, drawn as inline SVG that takes the text colour (currentColor). Only the
// names listed in ICONS are imported (named imports, so the bundle holds these and no other icon of the
// package); a new icon is one import and one line here. Nothing in this file imports three.js, core/ or
// features/, so the kanban page, the 2D view and the 3D office all use it.

import type { IconNode } from 'lucide';
import {
  SquareKanban, Building2, Package, Ticket, CircleDot, GitPullRequest, GitMerge, GitBranch, Inbox, Loader, Hand, Eye,
  CirclePause, CircleCheck, Archive, Hourglass, Play, Square, RotateCw, RefreshCw, ArrowRightLeft, Pencil, Trash2,
  Paperclip, Bot, MessageSquare, Mail, SquareTerminal, FileDiff, Target, MapPin, Settings, X, ChevronDown,
  ChevronRight, ChevronLeft, Search, Plus, ListFilter, Box, Ellipsis, CodeXml, Lock, ExternalLink, FileText, Check,
  Link, Unlink, TriangleAlert, User, Users, Signpost, CircleDashed, Wrench, GitPullRequestClosed, Download, Upload,
  Send, Copy, Info, CircleAlert, CircleX, Clock, Tag, Folder, FolderOpen, Sparkles, Brain, Keyboard, Undo2, LogOut,
  CornerUpLeft, ArrowUp, ArrowDown, ArrowRight, Minus, List, Filter, Star, Sun, Moon, Palette,
  Sprout, Plug, VolumeX, Wind, CloudRain, Footprints, Armchair, FastForward, Activity,
  Bell, BellOff, Calendar, Compass, Dices, Flag, Globe, House, Image, KeyRound, Layers, Save, Shield, Video, Volume2, ChevronUp, Zap, Hash, History, AtSign, CircleHelp, TrafficCone, Scissors,
} from 'lucide';

/** The icons by their Lucide (kebab-case) name. */
export const ICONS = {
  'square-kanban': SquareKanban,
  'building-2': Building2,
  'package': Package,
  'ticket': Ticket,
  'circle-dot': CircleDot,
  'git-pull-request': GitPullRequest,
  'git-merge': GitMerge,
  'git-branch': GitBranch,
  'inbox': Inbox,
  'loader': Loader,
  'hand': Hand,
  'eye': Eye,
  'circle-pause': CirclePause,
  'circle-check': CircleCheck,
  'archive': Archive,
  'hourglass': Hourglass,
  'play': Play,
  'square': Square,
  'rotate-cw': RotateCw,
  'refresh-cw': RefreshCw,
  'arrow-right-left': ArrowRightLeft,
  'pencil': Pencil,
  'trash-2': Trash2,
  'paperclip': Paperclip,
  'bot': Bot,
  'message-square': MessageSquare,
  'mail': Mail,
  'square-terminal': SquareTerminal,
  'file-diff': FileDiff,
  'target': Target,
  'map-pin': MapPin,
  'settings': Settings,
  'x': X,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft,
  'search': Search,
  'plus': Plus,
  'list-filter': ListFilter,
  'box': Box,
  'ellipsis': Ellipsis,
  'code-xml': CodeXml,
  'lock': Lock,
  'external-link': ExternalLink,
  'file-text': FileText,
  'check': Check,
  'link': Link,
  'unlink': Unlink,
  'triangle-alert': TriangleAlert,
  'user': User,
  'users': Users,
  'signpost': Signpost,
  'circle-dashed': CircleDashed,
  'wrench': Wrench,
  'git-pull-request-closed': GitPullRequestClosed,
  'download': Download,
  'upload': Upload,
  'send': Send,
  'copy': Copy,
  'info': Info,
  'circle-alert': CircleAlert,
  'circle-x': CircleX,
  'clock': Clock,
  'tag': Tag,
  'folder': Folder,
  'folder-open': FolderOpen,
  'sparkles': Sparkles,
  'brain': Brain,
  'keyboard': Keyboard,
  'undo-2': Undo2,
  'log-out': LogOut,
  'corner-up-left': CornerUpLeft,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  'arrow-right': ArrowRight,
  'minus': Minus,
  'list': List,
  'filter': Filter,
  'star': Star,
  'sun': Sun,
  'moon': Moon,
  'palette': Palette,
  'sprout': Sprout,
  'bell': Bell,
  'bell-off': BellOff,
  'calendar': Calendar,
  'compass': Compass,
  'dices': Dices,
  'flag': Flag,
  'globe': Globe,
  'house': House,
  'image': Image,
  'key-round': KeyRound,
  'layers': Layers,
  'save': Save,
  'shield': Shield,
  'video': Video,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  'plug': Plug,
  'wind': Wind,
  'cloud-rain': CloudRain,
  'footprints': Footprints,
  'armchair': Armchair,
  'fast-forward': FastForward,
  'activity': Activity,
  'chevron-up': ChevronUp,
  'zap': Zap,
  'hash': Hash,
  'history': History,
  'at-sign': AtSign,
  'circle-help': CircleHelp,
  'traffic-cone': TrafficCone,
  'scissors': Scissors,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * An icon as an inline SVG, 24 units wide, `size` px on screen (16 by default), in the colour of the text
 * around it. Decorative (aria-hidden) unless it has a `label`, which makes it an image of that name.
 */
export function icon(name: IconName, opts: { size?: number; label?: string; cls?: string } = {}): SVGSVGElement {
  const size = String(opts.size ?? 16);
  const svg = document.createElementNS(SVG_NS, 'svg');
  const set = (k: string, v: string) => svg.setAttribute(k, v);
  set('class', opts.cls ? `i ${opts.cls}` : 'i');
  set('viewBox', '0 0 24 24');
  set('width', size);
  set('height', size);
  set('fill', 'none');
  set('stroke', 'currentColor');
  set('stroke-width', '1.75');
  set('stroke-linecap', 'round');
  set('stroke-linejoin', 'round');
  if (opts.label) {
    set('role', 'img');
    set('aria-label', opts.label);
  } else set('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[name]) {
    const part = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) part.setAttribute(k, String(v));
    svg.append(part);
  }
  return svg;
}

/** An icon and its text, as the children of h(): h('button.btn', {}, ...withIcon('play', 'Start')). */
export function withIcon(name: IconName, text: string, size?: number): [SVGSVGElement, string] {
  return [icon(name, { size }), text];
}

/** A button that is only an icon: its name for screen readers and its tooltip is `label`. */
export function iconButton(name: IconName, label: string, attrs: Record<string, unknown> = {}, size?: number): HTMLButtonElement {
  // Built without ui/dom.ts's h(), which draws its ✕ with icon(): the two files would import each other.
  const b = document.createElement('button');
  b.className = 'btn icon-btn';
  b.setAttribute('type', 'button');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') b.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') b.className = `${b.className} ${String(v)}`.trim();
    else b.setAttribute(k, v === true ? '' : String(v));
  }
  b.setAttribute('aria-label', label);
  b.setAttribute('title', label);
  b.append(icon(name, { size }));
  return b;
}
