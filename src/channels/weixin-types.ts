/** Weixin (微信) channel configuration using the open platform API. */
export interface WeixinChannelConfig {
  type: "weixin";
  /** The Weixin account ID obtained after QR login. */
  accountId: string;
  /** Bot API token for authentication. */
  token: string;
  /** The authenticated user's ID. */
  userId: string;
}
