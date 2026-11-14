import {
  DeviceRouteRegistry,
  intakeArtifactRoutes,
  type DeviceRoute,
} from "../workbench/device-http.js";
import { McpHttpService } from "../mcp/http.js";
import type { Application, QueryApplication } from "./application.js";
import { importHttpRoutes } from "../workbench/import-http.js";
import { captureHttpRoutes } from "../workbench/capture-http.js";

/** Single registration table for intake and HTTP MCP.
 * No existing Web/query/maintenance endpoint is implicitly exposed to devices.
 */
export function deviceBusinessRoutes(
  application: Application,
  query?: QueryApplication,
  artifactDirectory?: URL,
): DeviceRouteRegistry {
  const mcp = new McpHttpService(application, query);
  const routes: DeviceRoute[] = [
    ...importHttpRoutes(
      application.importSessions,
      application.deviceConnections,
    ),
    ...captureHttpRoutes(application.capture),
    ...intakeArtifactRoutes(artifactDirectory),
    ...mcp.routes(),
  ];
  return new DeviceRouteRegistry(routes, () => mcp.close());
}
