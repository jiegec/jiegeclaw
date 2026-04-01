/**
 * Weixin channel registration.
 *
 * Registers the Weixin channel with the global registry.
 */

import { registry } from "./registry.js";
import { WeixinChannel } from "./weixin.js";
import type { WeixinChannelConfig } from "./weixin-types.js";

registry.register("weixin", {
  factory: (config) => new WeixinChannel(config as WeixinChannelConfig),
  onboard: WeixinChannel.onboard,
});
