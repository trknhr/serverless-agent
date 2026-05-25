import { AgentCoreBrowserProvider } from "./agentcoreBrowserProvider";
import type { BrowserProvider } from "./provider";
import { normalizeBrowserProviderName } from "./provider";

export interface BrowserProviderFactoryOptions {
  provider?: string;
  region?: string;
  browserIdentifier?: string;
}

export function createBrowserProvider(options: BrowserProviderFactoryOptions): BrowserProvider | undefined {
  const provider = normalizeBrowserProviderName(options.provider);
  if (!provider) {
    return undefined;
  }

  switch (provider) {
    case "agentcore-browser":
      return new AgentCoreBrowserProvider({
        region: options.region,
        browserIdentifier: options.browserIdentifier,
      });
  }
}
