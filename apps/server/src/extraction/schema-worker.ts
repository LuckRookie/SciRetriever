import { Ajv2020 } from "ajv/dist/2020.js";
import { parentPort, workerData } from "node:worker_threads";

const input = workerData as {
  readonly schema: object;
  readonly payload?: unknown;
  readonly payloads?: readonly unknown[];
};
try {
  const ajv = new Ajv2020({
    strict: true,
    allowUnionTypes: true,
    inlineRefs: false,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: false,
  });
  const validate = ajv.compile(input.schema);
  if (Object.hasOwn(input, "payloads")) {
    const payloads = input.payloads;
    if (!Array.isArray(payloads) || payloads.length > 64)
      throw new Error("invalid payload batch");
    let issue: { instance_path: string; keyword: string } | null = null;
    for (let index = 0; index < payloads.length; index++) {
      if (validate(payloads[index])) continue;
      issue = {
        instance_path: `/${index}${validate.errors?.[0]?.instancePath ?? ""}`,
        keyword: validate.errors?.[0]?.keyword ?? "schema",
      };
      break;
    }
    parentPort?.postMessage({ valid: issue === null, issue });
  } else if (Object.hasOwn(input, "payload")) {
    const valid = validate(input.payload);
    parentPort?.postMessage({
      valid,
      issue: valid
        ? null
        : {
            instance_path: validate.errors?.[0]?.instancePath ?? "",
            keyword: validate.errors?.[0]?.keyword ?? "schema",
          },
    });
  } else {
    parentPort?.postMessage({ valid: true, issue: null });
  }
} catch {
  parentPort?.postMessage({
    valid: false,
    issue: { instance_path: "", keyword: "invalid-schema" },
  });
}
