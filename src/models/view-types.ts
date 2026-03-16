import type { TaskTreeNode } from "./types";
import type { OutlineTimeRange } from "../plugin";

export type TaskTreeData = {
  roots: TaskTreeNode[];
  cumulativeSeconds: Map<string, number>;
  ownSeconds: Map<string, number>;
  nodesByPath: Map<string, TaskTreeNode>;
};

export type TaskTreeBuildOptions = {
  ownSecondsForPath?: (path: string) => number;
  sortMode?: OutlineSortMode;
  latestTrackedStartForPath?: (path: string) => number;
};

export type TreeRenderState = {
  cumulativeSeconds: Map<string, number>;
  ownSeconds: Map<string, number>;
  matchedPaths: Set<string>;
  expandAll?: boolean;
};

export type OutlineFilterToken =
  | { key: "any" | "path" | "file"; value: string; negated: boolean }
  | { key: "prop"; prop: string; value: string | null; negated: boolean };

export type OutlineSortMode = "recent" | "priority";

export const VIEW_TYPE_LIFE_DASHBOARD_TIMER = "life-dashboard-timer-view";
export const VIEW_TYPE_LIFE_DASHBOARD_OUTLINE = "life-dashboard-outline-view";
export const VIEW_TYPE_LIFE_DASHBOARD_CANVAS = "life-dashboard-canvas-view";
export const VIEW_TYPE_LIFE_DASHBOARD_CALENDAR = "life-dashboard-calendar-view";
export const VIEW_TYPE_LIFE_DASHBOARD_TIMELOG = "life-dashboard-timelog-view";
export const VIEW_TYPE_LIFE_DASHBOARD_BEANCOUNT = "life-dashboard-beancount-view";
export const VIEW_TYPE_LIFE_DASHBOARD_TIMELINE = "life-dashboard-timeline-view";
export const VIEW_TYPE_LIFE_DASHBOARD_SUPPLEMENTS = "life-dashboard-supplements-view";
export const LIFE_DASHBOARD_VIEW_TYPES = [
  VIEW_TYPE_LIFE_DASHBOARD_TIMER,
  VIEW_TYPE_LIFE_DASHBOARD_OUTLINE,
  VIEW_TYPE_LIFE_DASHBOARD_CANVAS,
  VIEW_TYPE_LIFE_DASHBOARD_CALENDAR,
  VIEW_TYPE_LIFE_DASHBOARD_TIMELOG,
  VIEW_TYPE_LIFE_DASHBOARD_TIMELINE,
  VIEW_TYPE_LIFE_DASHBOARD_SUPPLEMENTS
] as const;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const DASHBOARD_COLORS = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
  "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
  "#9c755f", "#bab0ac"
];

export const MIN_TRACKED_SECONDS_PER_PERIOD = 60;

export const CLOSED_FILTER_QUERY = "-prop:status=done -prop:status=rejected -prop:archived=true";

export const OUTLINE_RANGE_OPTIONS: Array<{ value: OutlineTimeRange; label: string }> = [
  { value: "today", label: "today" },
  { value: "todayYesterday", label: "today+yesterday" },
  { value: "week", label: "this week" },
  { value: "month", label: "this month" },
  { value: "all", label: "all time" }
];

export const OUTLINE_SORT_OPTIONS: Array<{ value: OutlineSortMode; label: string }> = [
  { value: "recent", label: "recent tracked" },
  { value: "priority", label: "priority" }
];
