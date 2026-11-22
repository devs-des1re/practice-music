import type { EngineStatus } from "./types";

export const emptyEngine: EngineStatus = {
  state: "",
  pid: 0,
  restarts: 0,
  lastError: "",
  engineVersion: "",
  protocol: 0,
  features: [],
  startedAtMs: 0,
  retryInMs: 0,
  path: "",
};
