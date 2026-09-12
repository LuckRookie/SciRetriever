import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  bundlePreview,
  CredentialBoundaryError,
  type CredentialSectionPreview,
  credentialPath,
  issueCredentialGrant,
  issueProviderCredentialGrant,
  loadCredentialBundle,
  parseCredentialText,
  readCredential,
  readProviderCredential,
} from "../src/configuration/credentials.js";

function rejects(value: string): void {
  expect(() => parseCredentialText(value)).toThrow(CredentialBoundaryError);
}

const credentials = `
[providers.openai]
api_key = "model-secret"
origin = "https://api.openai.com"

[elsevier]
api_key = "metadata-secret"

[mineru]
bearer_token = "parser-secret"
origin = "https://mineru.example.invalid"
`;

describe("origin-bound credential grants", () => {
  it("keeps secrets in an opaque bundle and exposes only a migration preview", () => {
    const bundle = parseCredentialText(credentials);
    const preview = bundlePreview(bundle);
    expect(preview.sections).toEqual([
      {
        section: "providers.openai",
        fields: [{ field: "api_key", present: true }],
        origin: "https://api.openai.com",
        has_transition: false,
      },
      {
        section: "elsevier",
        fields: [{ field: "api_key", present: true }],
        origin: null,
        has_transition: false,
      },
      {
        section: "mineru",
        fields: [{ field: "bearer_token", present: true }],
        origin: "https://mineru.example.invalid",
        has_transition: false,
      },
    ]);
    expect(JSON.stringify(preview)).not.toContain("model-secret");
    expect(JSON.stringify(preview)).not.toContain("parser-secret");
    expect(JSON.stringify(bundle)).toBe("{}");
  });

  it("requires the same exact origin and operation before releasing one field", () => {
    const bundle = parseCredentialText(credentials);
    const grant = issueCredentialGrant(
      bundle,
      "model",
      "openai",
      "api_key",
      "https://api.openai.com/",
      "model-request",
      1000,
      10_000,
    );
    expect(
      readCredential(
        bundle,
        grant,
        "openai",
        "api_key",
        "https://api.openai.com",
        "model-request",
        10_100,
      ),
    ).toBe("model-secret");
    expect(() =>
      readCredential(
        bundle,
        grant,
        "openai",
        "api_key",
        "https://other.example.invalid",
        "model-request",
        10_100,
      ),
    ).toThrow(CredentialBoundaryError);
    const parserGrant = issueCredentialGrant(
      bundle,
      "core",
      "mineru",
      "bearer_token",
      "https://mineru.example.invalid",
      "parser-upload",
      1000,
      10_000,
    );
    expect(
      readCredential(
        bundle,
        parserGrant,
        "mineru",
        "bearer_token",
        "https://mineru.example.invalid",
        "parser-upload",
        10_001,
      ),
    ).toBe("parser-secret");
    expect(() =>
      issueCredentialGrant(
        bundle,
        "model",
        "openai",
        "api_key",
        "https://api.openai.com",
        "parser-upload",
      ),
    ).toThrow(CredentialBoundaryError);
    expect(() =>
      readCredential(
        bundle,
        grant,
        "openai",
        "api_key",
        "https://api.openai.com",
        "model-directory",
        10_100,
      ),
    ).toThrow(CredentialBoundaryError);
    expect(() =>
      readCredential(
        bundle,
        grant,
        "openai",
        "api_key",
        "https://api.openai.com",
        "model-request",
        11_000,
      ),
    ).toThrow(CredentialBoundaryError);
    expect(() =>
      readCredential(
        bundle,
        { ...grant },
        "openai",
        "api_key",
        "https://api.openai.com",
        "model-request",
        10_100,
      ),
    ).toThrow(CredentialBoundaryError);
  });

  it("accepts complete transition credentials while keeping both origins explicit", () => {
    const bundle = parseCredentialText(`[providers.openai]
api_key = "old-secret"
origin = "https://old.example.invalid"
next_api_key = "new-secret"
next_origin = "https://new.example.invalid"
`);
    expect(bundlePreview(bundle).sections[0]).toMatchObject({
      has_transition: true,
      origin: "https://old.example.invalid",
    });
    const grant = issueCredentialGrant(
      bundle,
      "model",
      "openai",
      "next_api_key",
      "https://new.example.invalid",
      "model-request",
      1000,
      10_000,
    );
    expect(
      readCredential(
        bundle,
        grant,
        "openai",
        "next_api_key",
        "https://new.example.invalid",
        "model-request",
        10_001,
      ),
    ).toBe("new-secret");
  });

  it("rejects unknown fields, incomplete transitions, non HTTPS origins and malformed TOML", () => {
    rejects(
      `[providers.openai]\napi_key = "secret"\norigin = "https://api.example.invalid"\nunknown = "x"`,
    );
    rejects(
      `[providers.openai]\napi_key = "secret"\norigin = "https://api.example.invalid"\nnext_api_key = "new"`,
    );
    rejects(
      `[providers.openai]\napi_key = "secret"\norigin = "http://api.example.invalid"`,
    );
    rejects(
      `[providers.openai]\napi_key = "secret"\norigin = "https://api.example.invalid/path"`,
    );
    rejects(`[sci-hub]\napi_key = "secret"`);
    rejects(`[providers.openai]\napi_key = "secret"\napi_key = "other"`);
  });

  it("keeps metadata and model namespaces separate and preserves secret code points", () => {
    const bundle = parseCredentialText(`[providers.elsevier]
api_key = "model-secret"
origin = "https://models.example.invalid"

[elsevier]
api_key = "é-secret"
`);
    const modelGrant = issueCredentialGrant(
      bundle,
      "model",
      "elsevier",
      "api_key",
      "https://models.example.invalid",
      "model-request",
      1000,
      10_000,
    );
    const providerGrant = issueProviderCredentialGrant(
      bundle,
      "elsevier",
      "api_key",
      1000,
      10_000,
    );
    expect(
      readCredential(
        bundle,
        modelGrant,
        "elsevier",
        "api_key",
        "https://models.example.invalid",
        "model-request",
        10_001,
      ),
    ).toBe("model-secret");
    expect(
      readProviderCredential(
        bundle,
        providerGrant,
        "elsevier",
        "api_key",
        10_001,
      ),
    ).toBe("é-secret");
  });

  it("binds grant issuance to the parsed bundle and rejects a mutated preview", () => {
    const bundle = parseCredentialText(credentials);
    const other = parseCredentialText(credentials);
    const grant = issueCredentialGrant(
      bundle,
      "model",
      "openai",
      "api_key",
      "https://api.openai.com",
      "model-request",
      1000,
      10_000,
    );
    const preview = bundlePreview(bundle);
    expect(() => {
      (preview.sections as CredentialSectionPreview[]).push({
        section: "forged",
        fields: [],
        origin: null,
        has_transition: false,
      });
    }).toThrow(TypeError);
    expect(() =>
      readCredential(
        other,
        grant,
        "openai",
        "api_key",
        "https://api.openai.com",
        "model-request",
        10_001,
      ),
    ).toThrow(CredentialBoundaryError);
  });

  it("reads only the injected fixed credentials path and treats a missing file as empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-credentials-"));
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    expect(credentialPath(home)).toBe(join(directory, "credentials.toml"));
    expect(bundlePreview(await loadCredentialBundle(home))).toEqual({
      sections: [],
    });
    await writeFile(join(directory, "credentials.toml"), credentials, {
      mode: 0o600,
    });
    expect(
      bundlePreview(await loadCredentialBundle(home)).sections,
    ).toHaveLength(3);
  });

  it("rejects credentials with non owner-only directory or file permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-credentials-"));
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "credentials.toml");
    await writeFile(path, credentials, { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(loadCredentialBundle(home)).rejects.toBeInstanceOf(
      CredentialBoundaryError,
    );
    await chmod(path, 0o600);
    await chmod(directory, 0o755);
    await expect(loadCredentialBundle(home)).rejects.toBeInstanceOf(
      CredentialBoundaryError,
    );
  });
});
