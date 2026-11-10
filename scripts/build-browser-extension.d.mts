export function buildBrowserExtension(target?: string): Promise<string>;
export function packageBrowserExtension(
  directory: string,
  destination?: string,
): Promise<string>;
export function zip(files: { name: string; bytes: Buffer }[]): Buffer;
