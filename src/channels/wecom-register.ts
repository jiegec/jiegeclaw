/**
 * WeCom channel registration.
 *
 * Registers the WeCom channel factory with the global registry.
 */

import { registry } from "./registry.js";
import { WecomChannel } from "./wecom.js";
import type { WecomChannelConfig } from "./wecom-types.js";

registry.register("wecom", (config, index, onConfigUpdate) => {
  return new WecomChannel(config as WecomChannelConfig, index, onConfigUpdate);
});
