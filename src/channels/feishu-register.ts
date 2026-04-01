/**
 * Feishu channel registration.
 *
 * Registers the Feishu channel with the global registry.
 */

import { registry } from "./registry.js";
import { FeishuChannel } from "./feishu.js";
import type { FeishuChannelConfig } from "./feishu-types.js";

registry.register("feishu", {
  factory: (config) => new FeishuChannel(config as FeishuChannelConfig),
  onboard: FeishuChannel.onboard,
});
