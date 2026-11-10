import {
  DeviceRouteRegistry,
  type DeviceRoute,
} from "../workbench/device-http.js";
import type { Application } from "./application.js";

/** Single registration table for 03 import, 07 HTTP MCP and 08 capture.
 * No existing Web/query/maintenance endpoint is implicitly exposed to devices.
 */
export function deviceBusinessRoutes(
  application: Application,
): DeviceRouteRegistry {
  // Future factories bind their business owner from this same Application.
  void application;
  const routes: DeviceRoute[] = [];
  return new DeviceRouteRegistry(routes);
}
