import { expect, it } from "vitest";
import type { Page } from "playwright";
import {
  ConfigurationProbeSession,
  TypeScriptConfigurationOwner,
} from "../../server/src/configuration/owner.js";
import type { AgentTransport } from "../../server/src/agents/protocol.js";
import { nextWorkspace } from "./next-workspace-fixture.js";

async function select(page: Page, label: string, option: string) {
  await page
    .getByRole("button", { name: new RegExp(label) })
    .and(page.locator('[aria-haspopup="listbox"]'))
    .click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function check(
  page: Page,
  name: string,
  checked: boolean,
  role: "checkbox" | "switch" = "checkbox",
) {
  const field = page.getByRole(role, { name, exact: true });
  if ((await field.isChecked()) !== checked) {
    await field.focus();
    await page.keyboard.press("Space");
  }
}
it("registers an empty model catalog, binds and probes the saved Browser model, and guards referenced edits and deletion", async () => {
  let owner: TypeScriptConfigurationOwner;
  let baseline = "";
  const calls: {
    endpoint: string;
    model: unknown;
    authorization: string | undefined;
  }[] = [];
  const key = "synthetic-catalog-key-never-rendered";
  const transport: AgentTransport = async (request) => {
    const wire = JSON.parse(new TextDecoder().decode(request.body)) as Record<
      string,
      unknown
    >;
    calls.push({
      endpoint: request.endpoint,
      model: wire.model,
      authorization: request.headers.find(
        ([name]) => name.toLowerCase() === "authorization",
      )?.[1],
    });
    return {
      status: 200,
      headers: [["content-type", "application/json"]],
      body: new TextEncoder().encode(
        JSON.stringify({
          object: "response",
          status: "completed",
          model: wire.model,
          output: [
            {
              type: "function_call",
              name: "sciretriever_probe_stop",
              arguments: '{"received":true}',
            },
          ],
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      ),
    };
  };
  const w = await nextWorkspace({
    path: "/?view=set",
    ready: 'label:has-text("Catalog 路径")',
    setup: async (env) => {
      owner = new TypeScriptConfigurationOwner(env.home);
      const initial = await owner.read();
      await owner.publishConfiguration(
        {
          ...initial.configuration,
          providers: {},
          models: {},
          analyze: { ...initial.configuration.analyze, model: null },
          browser: { ...initial.configuration.browser, model: null },
        },
        initial.revision,
        ["providers", "models", "analyze", "browser"],
      );
      baseline = (await owner.read()).revision;
    },
    configuration: () => ({
      runtime_revision: baseline,
      read: (signal) => owner.read(signal),
      status: (signal) => owner.status(signal),
      publishConfiguration: (configuration, revision, sections, signal) =>
        owner.publishConfiguration(configuration, revision, sections, signal),
      credential: (edit, revision, signal) =>
        owner.credential(edit, revision, signal),
      probe: async (request, signal) => {
        const session = await ConfigurationProbeSession.create(owner, {
          agent_transport: () => transport,
        });
        try {
          return await session.run(request, {
            authorized: true,
            ...(signal ? { signal } : {}),
          });
        } finally {
          session.close();
        }
      },
    }),
  });
  try {
    const page = w.page;
    expect((await owner!.read()).configuration.providers).toEqual({});
    expect((await owner!.read()).configuration.models).toEqual({});
    const tab = async (name: string) =>
      page.getByRole("tab", { name, exact: true }).click();
    const message = async (text: string) =>
      expect
        .poll(() => page.getByRole("status").allTextContents())
        .toContainEqual(expect.stringContaining(text));
    const save = async (name: string) => {
      const response = page.waitForResponse((r) =>
        r.url().includes("/api/configuration/publish-json"),
      );
      await page.getByRole("button", { name, exact: true }).click();
      expect((await response).status()).toBe(200);
    };
    await tab("文献来源");
    await page
      .getByRole("textbox", { name: "元数据结果上限", exact: true })
      .fill("777");
    await tab("模型");
    await page
      .getByRole("button", { name: "添加 Provider", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Provider 1 名称", exact: true })
      .fill("vision-fixture");
    await page
      .getByRole("textbox", { name: "Provider 1 Base URL", exact: true })
      .fill("https://provider.example.test/v1");
    await page.getByRole("button", { name: "添加 Model", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Model 1 远程名称", exact: true })
      .fill("remote-vision");
    await select(page, "Model 1 Reasoning", "low");
    await check(page, "Model 1 支持图像", true);
    await check(page, "Model 1 流式输出", false);
    await save("保存 Provider/Model");
    await message("Provider/Model已保存");
    const registered = await owner!.read();
    expect(registered.configuration.providers).toMatchObject({
      "vision-fixture": {
        api: "openai-responses",
        base_url: "https://provider.example.test/v1",
      },
    });
    expect(registered.configuration.models).toMatchObject({
      "vision-fixture/remote-vision": {
        reasoning: "low",
        image: true,
        stream: false,
      },
    });
    expect(registered.configuration.sources.metadata.limit).toBe(500);
    await tab("文献来源");
    expect(
      await page
        .getByRole("textbox", { name: "元数据结果上限", exact: true })
        .inputValue(),
    ).toBe("777");
    await tab("解析与 Browser");
    await select(page, "Browser 模型", "vision-fixture/remote-vision");
    await check(page, "启用 Browser", true, "switch");
    await page
      .getByRole("textbox", { name: "Browser profile", exact: true })
      .fill("synthetic-profile");
    await save("保存运行配置");
    await message("运行配置已保存");
    expect((await owner!.read()).configuration.browser).toMatchObject({
      enabled: true,
      profile: "synthetic-profile",
      model: "vision-fixture/remote-vision",
    });
    await owner!.credential(
      { namespace: "model", target: "vision-fixture", kind: "set", value: key },
      (await owner!.read()).revision,
    );
    const probe = async () => {
      const before = (await owner!.read()).revision;
      await page
        .getByRole("button", { name: "测试 Browser 模型", exact: true })
        .click();
      expect(calls.length).toBe(beforeProbe);
      await page
        .getByRole("dialog", { name: "测试连接", exact: true })
        .getByRole("button", { name: "确认测试", exact: true })
        .click();
      await expect.poll(() => calls.length).toBe(beforeProbe + 1);
      await message("测试通过，连接正常。");
      expect((await owner!.read()).revision).toBe(before);
    };
    let beforeProbe = 0;
    await probe();
    expect(calls[0]).toEqual({
      endpoint: "https://provider.example.test/v1/responses",
      model: "remote-vision",
      authorization: `Bearer ${key}`,
    });
    expect(await page.content()).not.toContain(key);
    expect(JSON.stringify(await owner!.read())).not.toContain(key);
    await tab("模型");
    const duplicateRevision = (await owner!.read()).revision;
    await page
      .getByRole("button", { name: "添加 Provider", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Provider 2 名称", exact: true })
      .fill("vision-fixture");
    await page
      .getByRole("textbox", { name: "Provider 2 Base URL", exact: true })
      .fill("https://duplicate.example.test/v1");
    await page
      .getByRole("button", { name: "保存 Provider/Model", exact: true })
      .click();
    await message("Provider 名称重复");
    expect((await owner!.read()).revision).toBe(duplicateRevision);
    await page.getByRole("button", { name: "刷新配置", exact: true }).click();
    await page.getByRole("button", { name: "读取保存值", exact: true }).click();
    await expect
      .poll(() =>
        page.getByRole("textbox", { name: /Provider \d 名称/ }).count(),
      )
      .toBe(1);
    await page
      .getByRole("textbox", { name: "Provider 1 Base URL", exact: true })
      .fill("https://provider.example.test/v2");
    await save("保存 Provider/Model");
    await message("Provider/Model已保存");
    expect(
      (await owner!.read()).configuration.providers["vision-fixture"]?.base_url,
    ).toBe("https://provider.example.test/v2");
    await select(page, "Browser 模型", "未选择");
    const beforeReferenced = (await owner!.read()).revision;
    await page
      .getByRole("textbox", { name: "Model 1 远程名称", exact: true })
      .fill("remote-vision-v2");
    await page
      .getByRole("button", { name: "保存 Provider/Model", exact: true })
      .click();
    await message("当前保存的 Browser 配置仍引用");
    expect((await owner!.read()).revision).toBe(beforeReferenced);
    await save("保存角色绑定");
    await message("运行配置已保存");
    await save("保存 Provider/Model");
    await message("Provider/Model已保存");
    expect((await owner!.read()).configuration.models).toHaveProperty(
      "vision-fixture/remote-vision-v2",
    );
    await select(page, "Browser 模型", "vision-fixture/remote-vision-v2");
    await save("保存角色绑定");
    await message("运行配置已保存");
    await tab("解析与 Browser");
    beforeProbe = 1;
    await probe();
    expect(calls[1]).toEqual({
      endpoint: "https://provider.example.test/v2/responses",
      model: "remote-vision-v2",
      authorization: `Bearer ${key}`,
    });
    await tab("模型");
    await page.getByRole("button", { name: "移除 Model", exact: true }).click();
    await message("模型仍有角色绑定");
    await page
      .getByRole("button", { name: "移除 Provider", exact: true })
      .click();
    await message("Provider 仍有模型引用");
    expect((await owner!.read()).configuration.providers).toHaveProperty(
      "vision-fixture",
    );
    await select(page, "Browser 模型", "未选择");
    await save("保存角色绑定");
    await message("运行配置已保存");
    await page.getByRole("button", { name: "移除 Model", exact: true }).click();
    await save("保存 Provider/Model");
    await message("Provider/Model已保存");
    expect((await owner!.read()).configuration.models).toEqual({});
    await page
      .getByRole("button", { name: "移除 Provider", exact: true })
      .click();
    await save("保存 Provider/Model");
    await message("Provider/Model已保存");
    expect((await owner!.read()).configuration.providers).toEqual({});
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
