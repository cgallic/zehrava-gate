'use strict';

const { GateTool } = require('./GateTool');

/**
 * GateToolkit wraps multiple LangChain Tools with Gate governance in one call.
 *
 * Each tool gets its own policy mapping. Unknown tools fall back to `__default__`.
 *
 * @example
 * const toolkit = new GateToolkit({
 *   tools: [emailTool, crmTool, searchTool],
 *   gate,
 *   policies: {
 *     'send-email':   'outbound-email',
 *     'crm-update':   'crm-low-risk',
 *     '__default__':  'crm-low-risk',
 *   },
 *   destinations: {
 *     'send-email':   'sendgrid.send',
 *     '__default__':  'generic.http',
 *   },
 * });
 *
 * const governedTools = toolkit.getTools();
 * // Pass governedTools to your agent as normal LangChain tools
 */
class GateToolkit {
  /**
   * @param {object} options
   * @param {Array}    options.tools        - Array of LangChain Tool instances
   * @param {object}   options.gate         - Gate SDK client
   * @param {object}   options.policies     - Map of tool.name → policyId. Use '__default__' as fallback.
   * @param {object}   [options.destinations] - Map of tool.name → destination string. Use '__default__' as fallback.
   * @param {object}   [options.toolOptions]  - Options passed to every GateTool (pollIntervalMs, timeoutMs, etc.)
   */
  constructor({ tools, gate, policies, destinations = {}, toolOptions = {} }) {
    if (!tools || !gate || !policies) {
      throw new Error('GateToolkit requires: tools, gate, policies');
    }

    this._tools = tools;
    this._gate = gate;
    this._policies = policies;
    this._destinations = destinations;
    this._toolOptions = toolOptions;
  }

  /**
   * Returns GateTool-wrapped versions of all tools.
   * @returns {GateTool[]}
   */
  getTools() {
    return this._tools.map(tool => {
      const policy      = this._policies[tool.name]      || this._policies['__default__']      || 'crm-low-risk';
      const destination = this._destinations[tool.name]  || this._destinations['__default__']  || `${tool.name}.generic`;
      return new GateTool({
        tool,
        gate: this._gate,
        policy,
        destination,
        toolOptions: this._toolOptions,
      });
    });
  }
}

module.exports = { GateToolkit };
