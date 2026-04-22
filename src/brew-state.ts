import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface Breadcrumb {
  date: string;
  type: "video" | "article" | "tutorial" | "project" | "reading" | "advanced";
  url: string;
  title: string;
  why_picked: string;
}

export interface PlannedBreadcrumb {
  type: Breadcrumb["type"];
  intent: string;
}

export interface LearningTrack {
  topic: string;
  started: string;
  breadcrumbs_delivered: Breadcrumb[];
  next_planned: PlannedBreadcrumb | null;
}

export interface AlternativeTopic {
  topic: string;
  one_line_pitch: string;
  why_picked: string;
}

export interface BrewState {
  current_track: LearningTrack | null;
  alternative_offered: AlternativeTopic | null;
  last_outbound_msg_id: string | null;
  last_ab_question: string | null;
  new_topic_streak: number;
  awaiting_response: boolean;
  last_updated: string | null;
}

export function emptyState(): BrewState {
  return {
    current_track: null,
    alternative_offered: null,
    last_outbound_msg_id: null,
    last_ab_question: null,
    new_topic_streak: 0,
    awaiting_response: false,
    last_updated: null,
  };
}

export function readBrewState(path: string): BrewState {
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(path, "utf-8")) };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
}

export function writeBrewState(path: string, state: BrewState): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function advanceBreadcrumb(state: BrewState, delivered: Breadcrumb): BrewState {
  if (!state.current_track) throw new Error("advanceBreadcrumb: no current_track");
  return {
    ...state,
    current_track: {
      ...state.current_track,
      breadcrumbs_delivered: [...state.current_track.breadcrumbs_delivered, delivered],
      next_planned: null,
    },
  };
}

export function rotateTopic(state: BrewState, today: string): BrewState {
  if (!state.alternative_offered) throw new Error("rotateTopic: no alternative_offered");
  return {
    ...state,
    current_track: {
      topic: state.alternative_offered.topic,
      started: today,
      breadcrumbs_delivered: [],
      next_planned: null,
    },
    alternative_offered: null,
  };
}

export function tickStreak(state: BrewState, choice: "continue" | "switch" | "hold"): BrewState {
  if (choice === "continue") return { ...state, new_topic_streak: 0 };
  if (choice === "switch") return { ...state, new_topic_streak: state.new_topic_streak + 1 };
  return state;
}
