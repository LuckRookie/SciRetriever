import { provider, type ProviderRegistration } from "../contracts.js";
export const services = Object.freeze({});
export const definition = provider({
  metadata: [],
  acquisition: "public",
  credentialFields: [],
});
export const BUILTIN_SCI_HUB_MIRROR_URLS = Object.freeze([
  "https://sci-hub.ru",
  "https://sci-hub.kr",
] as const);
export const registration: ProviderRegistration = Object.freeze({
  id: "sci-hub",
  definition,
  services,
});
