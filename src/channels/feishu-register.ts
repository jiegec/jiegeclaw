/**
 * Feishu channel registration.
 *
 * Registers the Feishu channel factory with the global registry.
 */

import { registry } from "./registry.js";
import { FeishuChannel } from "./feishu.js";
import type { FeishuChannelConfig } from "./feishu-types.js";

registry.register("feishu", (config, index, onConfigUpdate) => {
  return new FeishuChannel(config as FeishuChannelConfig, index, onConfigUpdate);
});
