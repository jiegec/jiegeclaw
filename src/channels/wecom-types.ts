/** WeCom (企业微信) AI bot channel configuration. */
export interface WecomChannelConfig {
  type: "wecom";
  /** WeCom bot ID. */
  botId?: string;
  /** WeCom bot secret. */
  secret?: string;
}
