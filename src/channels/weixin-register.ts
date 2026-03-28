/**
 * Weixin channel registration.
 *
 * Registers the Weixin channel factory with the global registry.
 */

import { registry } from "./registry.js";
import { WeixinChannel } from "./weixin.js";
import type { WeixinChannelConfig } from "./weixin-types.js";

registry.register("weixin", (config, index, onConfigUpdate) => {
  return new WeixinChannel(config as WeixinChannelConfig, index, onConfigUpdate);
});
