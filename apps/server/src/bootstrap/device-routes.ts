import {
  DeviceRouteRegistry,
  type DeviceRoute,
} from "../workbench/device-http.js";
import { McpHttpService } from "../mcp/http.js";
import type { Application, QueryApplication } from "./application.js";
import { importHttpRoutes } from "../workbench/import-http.js";

/** Single registration table for 03 import, 07 HTTP MCP and 08 capture.
 * No existing Web/query/maintenance endpoint is implicitly exposed to devices.
 */
export function deviceBusinessRoutes(
  application: Application,
  query?: QueryApplication,
): DeviceRouteRegistry {
  const mcp = new McpHttpService(application, query);
  const routes: DeviceRoute[] = [
    ...importHttpRoutes(application.importSessions),
    ...mcp.routes(),
  ];
  return new DeviceRouteRegistry(routes, () => mcp.close());
}
