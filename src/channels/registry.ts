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
export type ChannelFactory = (
  config: ChannelConfig,
  index: number,
  onConfigUpdate: (index: number, update: Record<string, unknown>) => void,
) => Channel;

/**
 * Registry for channel type factories.
 */
class ChannelRegistry {
  private factories = new Map<string, ChannelFactory>();

  /**
   * Register a channel factory for a given type.
   * @param type - The channel type identifier (e.g., 'weixin', 'feishu', 'wecom')
   * @param factory - Factory function that creates channel instances
   */
  register(type: string, factory: ChannelFactory): void {
    this.factories.set(type, factory);
  }

  /**
   * Check if a channel type is registered.
   * @param type - The channel type to check
   * @returns true if the type is registered
   */
  has(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * Create a channel instance for the given configuration.
   * @param config - Channel configuration
   * @param index - Index in the config array
   * @param onConfigUpdate - Callback for config updates
   * @returns Channel instance
   * @throws Error if channel type is not registered
   */
  create(
    config: ChannelConfig,
    index: number,
    onConfigUpdate: (index: number, update: Record<string, unknown>) => void,
  ): Channel {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new Error(`Unknown channel type: ${config.type}`);
    }
    return factory(config, index, onConfigUpdate);
  }

  /**
   * Get all registered channel types.
   * @returns Array of registered type names
   */
  getTypes(): string[] {
    return Array.from(this.factories.keys());
  }
}

// Global registry instance
export const registry = new ChannelRegistry();
