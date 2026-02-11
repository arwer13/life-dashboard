export interface LifeDashboardSettings {
  propertyName: string;
  propertyValue: string;
  additionalFilterPropertyName: string;
  additionalFilterPropertyValue: string;
  caseSensitive: boolean;
  timeLogPath: string;
  viewWasVisible: boolean;
  selectedTaskPath: string;
  activeTrackingStart: number | null;
  activeTrackingTaskPath: string;
  activeTrackingTaskId: string;
}

export const DEFAULT_SETTINGS: LifeDashboardSettings = {
  propertyName: "type",
  propertyValue: "concen",
  additionalFilterPropertyName: "",
  additionalFilterPropertyValue: "",
  caseSensitive: false,
  timeLogPath: "Data/time/time-tracked.json",
  viewWasVisible: false,
  selectedTaskPath: "",
  activeTrackingStart: null,
  activeTrackingTaskPath: "",
  activeTrackingTaskId: ""
};
