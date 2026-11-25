export function mupdfBundleReady(
  bundle: string,
  platform?: string,
): Promise<boolean>;
export class MupdfBuildError extends Error {}
export function ensureMupdf(options?: {
  output?: string;
  build?: (options: { output: string }) => Promise<unknown>;
  findTool?: (name: string) => Promise<boolean>;
  log?: (text: string) => void;
}): Promise<{ built: boolean; output: string }>;
