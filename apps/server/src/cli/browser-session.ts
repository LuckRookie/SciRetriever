import { Readable } from "node:stream";
import {
  ContractValidationError,
  parseStrictJsonValue,
} from "@sciretriever/contracts";
import { operationRecord } from "../entry/query-operations.js";
import {
  MachineWorkbenchClient,
  MachineWorkbenchError,
  type WorkbenchOperation,
} from "../workbench/machine-client.js";

/** One persistent noninteractive connection: each NDJSON request gets one NDJSON reply. */
export async function runBrowserSession(
  client: MachineWorkbenchClient,
  input: AsyncIterable<Uint8Array>,
  output: (text: string) => void,
  signal?: AbortSignal,
) {
  const stream = Readable.from(input);
  const abort = () => {
    const error = new MachineWorkbenchError("operation-cancelled");
    if (input instanceof Readable) input.destroy();
    stream.destroy(error);
  };
  signal?.addEventListener("abort", abort, { once: true });
  let buffered = Buffer.alloc(0),
    completed = 0,
    failed = 0;
  const dispatch = async (bytes: Buffer) => {
    if (!bytes.toString("utf8").trim()) return;
    signal?.throwIfAborted();
    let result: unknown;
    try {
      const r = operationRecord(parseStrictJsonValue(bytes), [
        "operation",
        "request",
      ]);
      result = await client.execute(
        r.operation as WorkbenchOperation,
        r.request,
        signal,
      );
      completed++;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        !(
          error instanceof MachineWorkbenchError ||
          error instanceof ContractValidationError
        )
      )
        throw error;
      result = {
        failure: {
          code:
            error instanceof MachineWorkbenchError
              ? error.code
              : "invalid-request",
        },
      };
      failed++;
    }
    output(`${JSON.stringify({ protocol_version: 1, result })}\n`);
  };
  try {
    if (signal?.aborted) abort();
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      // Bound each request before decoding, including an unterminated line.
      const bytes = Buffer.from(chunk);
      let offset = 0;
      for (;;) {
        const newline = bytes.indexOf(10, offset);
        const end = newline === -1 ? bytes.length : newline;
        if (buffered.length + end - offset > 256 * 1024)
          throw new MachineWorkbenchError("request-budget");
        buffered = Buffer.concat([buffered, bytes.subarray(offset, end)]);
        if (newline === -1) break;
        await dispatch(buffered);
        buffered = Buffer.alloc(0);
        offset = newline + 1;
      }
    }
    await dispatch(buffered);
    return { completed, failed };
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
    if (input instanceof Readable) input.destroy();
  }
}
