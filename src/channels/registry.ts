/**
 * Channel registry for managing messaging channel implementations.
 *
 * Provides a registry pattern for channel types, allowing new channels
 * to be registered without modifying the core configuration code.
 */

import type { Channel } from "../types.js";
import type { ChannelConfig } from "../config.js";

/**
 * Factory function type for creating channel instances.
 */
export type ChannelFactory = (config: ChannelConfig) => Channel;

/**
 * Onboard function type for interactive channel setup.
 * Returns complete channel config with credentials obtained during setup.
 */
export type OnboardFunction = () => Promise<ChannelConfig>;

/**
 * Channel registration containing factory and onboard function.
 */
export interface ChannelRegistration {
  factory: ChannelFactory;
  onboard: OnboardFunction;
}

/**
 * Registry for channel registrations.
 */
class ChannelRegistry {
  private channels = new Map<string, ChannelRegistration>();

  /**
   * Register a channel for a given type.
   * @param type - The channel type identifier (e.g., 'weixin', 'feishu', 'wecom')
   * @param registration - Channel registration with factory and onboard
   */
  register(type: string, registration: ChannelRegistration): void {
    this.channels.set(type, registration);
  }

  /**
   * Check if a channel type is registered.
   * @param type - The channel type to check
   * @returns true if the type is registered
   */
  has(type: string): boolean {
    return this.channels.has(type);
  }

  /**
   * Create a channel instance for the given configuration.
   * @param config - Channel configuration
   * @returns Channel instance
   * @throws Error if channel type is not registered
   */
  create(config: ChannelConfig): Channel {
    const reg = this.channels.get(config.type);
    if (!reg) {
      throw new Error(`Unknown channel type: ${config.type}`);
    }
    return reg.factory(config);
  }

  /**
   * Get the onboard function for a channel type.
   * @param type - The channel type
   * @returns Onboard function
   * @throws Error if channel type is not registered
   */
  getOnboard(type: string): OnboardFunction {
    const reg = this.channels.get(type);
    if (!reg) {
      throw new Error(`Unknown channel type: ${type}`);
    }
    return reg.onboard;
  }

  /**
   * Get all registered channel types.
   * @returns Array of registered type names
   */
  getTypes(): string[] {
    return Array.from(this.channels.keys());
  }
}

// Global registry instance
export const registry = new ChannelRegistry();
