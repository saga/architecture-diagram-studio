import { describe, expect, it } from "vitest";
import { chooseRuntimeModel, describeModelRouting, isModelConfiguredWithoutProvider, readCopilotProvider, toProviderConfig, type CopilotProvider } from "./model-routing";

const github: CopilotProvider = { mode: "github", type: "openai" };
const byok: CopilotProvider = { mode: "byok", type: "openai", baseUrl: "https://api.deepseek.com/v1", host: "api.deepseek.com", model: "deepseek-flash" };

describe("readCopilotProvider", () => {
  it("treats a provider base URL as the switch into custom-provider mode", () => {
    const provider = readCopilotProvider({
      COPILOT_PROVIDER_BASE_URL: "https://api.deepseek.com/v1",
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_MODEL: "deepseek-flash"
    } as NodeJS.ProcessEnv);
    expect(provider.mode).toBe("byok");
    expect(provider.host).toBe("api.deepseek.com");
    expect(provider.model).toBe("deepseek-flash");
  });

  it("reports GitHub routing when only a model is configured", () => {
    const provider = readCopilotProvider({ COPILOT_MODEL: "deepseek-flash" } as NodeJS.ProcessEnv);
    expect(provider.mode).toBe("github");
    expect(provider.model).toBe("deepseek-flash");
    expect(provider.baseUrl).toBeUndefined();
  });

  it("falls back to the provider model id and ignores blank values", () => {
    const provider = readCopilotProvider({ COPILOT_MODEL: "  ", COPILOT_PROVIDER_MODEL_ID: "deepseek-v4" } as NodeJS.ProcessEnv);
    expect(provider.model).toBe("deepseek-v4");
    expect(provider.mode).toBe("github");
  });

  it("keeps an unparseable base URL out of the host field", () => {
    const provider = readCopilotProvider({ COPILOT_PROVIDER_BASE_URL: "not a url" } as NodeJS.ProcessEnv);
    expect(provider.mode).toBe("byok");
    expect(provider.host).toBeUndefined();
  });
});

describe("chooseRuntimeModel", () => {
  it("uses the configured custom model instead of an unrelated stored id", () => {
    const choice = chooseRuntimeModel({ requested: "claude-sonnet-5.5", provider: byok, available: [] });
    expect(choice).toMatchObject({ model: "deepseek-flash", substituted: true, reason: "byok" });
  });

  it("keeps a request that already names the custom model", () => {
    const choice = chooseRuntimeModel({ requested: "deepseek-flash", provider: byok, available: [] });
    expect(choice).toMatchObject({ model: "deepseek-flash", substituted: false, reason: "byok" });
  });

  it("keeps the requested model when GitHub reports it", () => {
    const choice = chooseRuntimeModel({ requested: "gpt-6-luna", provider: github, available: ["gpt-6-luna", "claude-sonnet-4.6"] });
    expect(choice).toMatchObject({ model: "gpt-6-luna", substituted: false, reason: "requested" });
  });

  it("replaces an unknown id with the configured model before auto-routing can happen", () => {
    const provider = { ...github, model: "gpt-6-luna" };
    const choice = chooseRuntimeModel({ requested: "claude-sonnet-5.5", provider, available: ["gpt-6-luna"] });
    expect(choice).toMatchObject({ model: "gpt-6-luna", substituted: true, reason: "catalog-default" });
  });

  it("falls back to the first reported model when nothing configured matches", () => {
    const choice = chooseRuntimeModel({ requested: "claude-sonnet-5.5", provider: { ...github, model: "retired-model" }, available: ["gpt-6-luna"] });
    expect(choice).toMatchObject({ model: "gpt-6-luna", substituted: true, reason: "catalog-first" });
  });

  it("leaves the request alone when the catalog cannot be read", () => {
    const choice = chooseRuntimeModel({ requested: "claude-sonnet-5.5", provider: github, available: [] });
    expect(choice).toMatchObject({ model: "claude-sonnet-5.5", substituted: false, reason: "requested" });
  });

  it("uses the configured model when the request names none and the catalog is empty", () => {
    const choice = chooseRuntimeModel({ requested: "", provider: { ...github, model: "gpt-6-luna" }, available: [] });
    expect(choice).toMatchObject({ model: "gpt-6-luna", substituted: false, reason: "requested" });
  });

  it("reports an unresolved model when neither a request nor a configuration exists", () => {
    const choice = chooseRuntimeModel({ requested: "", provider: github, available: [] });
    expect(choice).toMatchObject({ model: "", reason: "unresolved" });
  });
});

describe("routing diagnostics", () => {
  it("names the custom endpoint and model", () => {
    expect(describeModelRouting(byok)).toContain("api.deepseek.com");
    expect(describeModelRouting(byok)).toContain("deepseek-flash");
  });

  it("flags a model that no custom provider can serve", () => {
    expect(isModelConfiguredWithoutProvider({ ...github, model: "deepseek-flash" })).toBe(true);
    expect(isModelConfiguredWithoutProvider(github)).toBe(false);
    expect(isModelConfiguredWithoutProvider(byok)).toBe(false);
  });
});

describe("toProviderConfig", () => {
  it("builds the session provider that actually routes traffic away from the Copilot API", () => {
    const config = toProviderConfig({ ...byok, apiKey: "sk-test", wireModel: "deepseek-flash-wire" });
    expect(config).toMatchObject({
      type: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      modelId: "deepseek-flash",
      wireModel: "deepseek-flash-wire"
    });
  });

  it("defaults the wire model to the configured model", () => {
    expect(toProviderConfig({ ...byok, apiKey: "sk-test" })?.wireModel).toBe("deepseek-flash");
  });

  it("sends nothing for GitHub routing", () => {
    expect(toProviderConfig({ ...github, apiKey: "sk-test" })).toBeUndefined();
  });

  it("omits empty credentials instead of sending blank headers", () => {
    const config = toProviderConfig(byok);
    expect(config && "apiKey" in config).toBe(false);
    expect(config && "bearerToken" in config).toBe(false);
  });

  it("passes provider-only headers and token limits through", () => {
    const config = toProviderConfig({ ...byok, headers: { "X-Tenant": "studio" }, maxPromptTokens: 64_000, maxOutputTokens: 8_000 });
    expect(config).toMatchObject({ headers: { "X-Tenant": "studio" }, maxPromptTokens: 64_000, maxOutputTokens: 8_000 });
  });
});
