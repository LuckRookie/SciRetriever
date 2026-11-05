import type {
  NetworkEgress,
  OutboundNetworkConfiguration,
} from "@sciretriever/contracts";
import type { OutboundEgress } from "../network/egress.js";
import {
  readProxyCredential,
  type CredentialBundle,
  type CurrentCredentialReader,
} from "./credentials.js";

export type NetworkRequester =
  | { readonly kind: "source"; readonly id: string }
  | { readonly kind: "provider"; readonly id: string }
  | { readonly kind: "doi-resolution" | "mineru" | "browser" | "proxy-test" };
export function selectedEgress(
  configuration: OutboundNetworkConfiguration | undefined,
  requester: NetworkRequester,
): NetworkEgress {
  const v = configuration?.via_proxy;
  const selected =
    requester.kind === "proxy-test" ||
    (requester.kind === "source"
      ? v?.sources.includes(requester.id)
      : requester.kind === "provider"
        ? v?.providers.includes(requester.id)
        : requester.kind === "doi-resolution"
          ? v?.doi_resolution
          : requester.kind === "mineru"
            ? v?.mineru
            : v?.browser);
  return selected ? "proxy" : "direct";
}
export function outboundEgress(
  configuration: OutboundNetworkConfiguration | undefined,
  requester: NetworkRequester,
  bundle?: CredentialBundle,
  current?: CurrentCredentialReader,
): OutboundEgress {
  const mode = selectedEgress(configuration, requester);
  if (mode === "direct") return { mode };
  if (!configuration?.proxy) return { mode };
  const origin = configuration.proxy;
  return {
    mode,
    proxy: {
      origin,
      authorization: async () =>
        current
          ? current({
              namespace: "core",
              provider: "proxy",
              field: "basic_auth",
              origin,
              operation: "proxy-connect",
            })
          : bundle
            ? readProxyCredential(bundle, origin)
            : null,
    },
  };
}
