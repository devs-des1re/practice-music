import { Devices } from "../../api/host.go";
import { logger } from "./logger";
import type { DeviceList } from "./types";

export interface DeviceTarget {
  setList: (value: DeviceList) => void;
  setLoaded: (value: boolean) => void;
  setError: (value: string) => void;
  setLoading: (value: boolean) => void;
}

export const emptyDevices: DeviceList = { hosts: [], devices: [] };

export async function loadDevices(target: DeviceTarget) {
  target.setLoading(true);
  target.setError("");
  try {
    target.setList(await Devices());
    target.setLoaded(true);
  } catch (e) {
    logger.error("device listing failed", e);
    target.setError(e instanceof Error ? e.message : String(e));
  } finally {
    target.setLoading(false);
  }
}
