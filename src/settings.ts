export interface LifeDashboardSettings {
  propertyName: string;
  propertyValue: string;
  additionalFilterPropertyName: string;
  additionalFilterPropertyValue: string;
  caseSensitive: boolean;
  outlineFilterQuery: string;
  timeLogPath: string;
  timeLogSchemaVersion: number;
  viewWasVisible: boolean;
  selectedTaskPath: string;
  activeTrackingStart: number | null;
  activeTrackingTaskPath: string;
  activeTrackingTaskId: string;
  minimumTrackableMinutes: number;
  weekStartsOn: "monday" | "sunday";
}

export const DEFAULT_TIME_LOG_PATH = "Data/time/time-tracked.json";
export const CURRENT_TIME_LOG_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: LifeDashboardSettings = {
  propertyName: "type",
  propertyValue: "concen",
  additionalFilterPropertyName: "",
  additionalFilterPropertyValue: "",
  caseSensitive: false,
  outlineFilterQuery: "",
  timeLogPath: DEFAULT_TIME_LOG_PATH,
  timeLogSchemaVersion: 0,
  viewWasVisible: false,
  selectedTaskPath: "",
  activeTrackingStart: null,
  activeTrackingTaskPath: "",
  activeTrackingTaskId: "",
  minimumTrackableMinutes: 2,
  weekStartsOn: "monday"
};
