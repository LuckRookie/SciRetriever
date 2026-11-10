import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type SdkTransport = Pick<Transport, "start" | "close" | "send"> & {
  readonly sessionId?: string | undefined;
  onclose?: NonNullable<Transport["onclose"]> | undefined;
  onerror?: NonNullable<Transport["onerror"]> | undefined;
  onmessage?: NonNullable<Transport["onmessage"]> | undefined;
};
/** SDK 1.27.1 HTTP accessors include undefined; preserve its protocol behavior under exact optional types. */
export class SdkTransportAdapter implements Transport {
  sessionId?: string;
  onclose?: NonNullable<Transport["onclose"]>;
  onerror?: NonNullable<Transport["onerror"]>;
  onmessage?: NonNullable<Transport["onmessage"]>;
  constructor(private readonly sdk: SdkTransport) {
    sdk.onclose = () => this.onclose?.();
    sdk.onerror = (error) => this.onerror?.(error);
    sdk.onmessage = (message, extra) => {
      this.identity();
      this.onmessage?.(message, extra);
    };
  }
  private identity() {
    if (this.sdk.sessionId === undefined) delete this.sessionId;
    else this.sessionId = this.sdk.sessionId;
  }
  async start() {
    await this.sdk.start();
    this.identity();
  }
  close() {
    return this.sdk.close();
  }
  async send(...args: Parameters<Transport["send"]>) {
    await this.sdk.send(...args);
    this.identity();
  }
}
