const { v4: uuidv4 } = require('uuid');

class SentinelSDK {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.SENTINEL_API_KEY;
    this.endpoint = config.endpoint || process.env.SENTINEL_ENDPOINT || 'http://localhost:3000/v1';
    this.agentId = config.agentId || 'unknown-agent';
    this.timeout = config.timeout || 30000;
    this.maxLoopCount = config.maxLoopCount || 3;
    this.autoRetry = config.autoRetry !== false;
    this.maxRetries = config.maxRetries || 2;
  }

  // Initialize SDK
  init(config) {
    Object.assign(this, config);
    return this;
  }

  // Generate a new run ID
  startRun() {
    return uuidv4();
  }

  // Send event to Sentinel API
  async sendEvent(event) {
    if (!this.apiKey) {
      console.warn('Sentinel: No API key configured, events not sent');
      return null;
    }

    try {
      const response = await fetch(`${this.endpoint}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(event)
      });

      if (!response.ok) {
        console.error('Sentinel: Failed to send event', await response.text());
      }

      return await response.json();
    } catch (err) {
      console.error('Sentinel: Error sending event', err.message);
      return null;
    }
  }

  // Wrap a function with Sentinel monitoring
  wrap(fn, options = {}) {
    const sdk = this;
    const opts = {
      name: options.name || fn.name || 'anonymous',
      timeout: options.timeout || this.timeout,
      ...options
    };

    return async function(...args) {
      const runId = sdk.startRun();
      const startTime = Date.now();
      
      // Send start event
      await sdk.sendEvent({
        agent_id: sdk.agentId,
        run_id: runId,
        type: 'run.start',
        payload: {
          function: opts.name,
          args_count: args.length
        },
        timestamp: startTime
      });

      // Track step count for loop detection
      let stepCount = 0;
      const maxSteps = opts.maxSteps || 100;

      try {
        // Set up timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Run exceeded timeout of ${opts.timeout}ms`));
          }, opts.timeout);
        });

        // Execute wrapped function
        const result = await Promise.race([
          fn.apply(this, args),
          timeoutPromise
        ]);

        const duration = Date.now() - startTime;

        // Send success event
        await sdk.sendEvent({
          agent_id: sdk.agentId,
          run_id: runId,
          type: 'run.complete',
          payload: {
            function: opts.name,
            duration,
            result_type: typeof result
          },
          timestamp: Date.now()
        });

        return result;

      } catch (error) {
        const duration = Date.now() - startTime;
        const isTimeout = error.message?.includes('timeout');

        // Send failure event
        await sdk.sendEvent({
          agent_id: sdk.agentId,
          run_id: runId,
          type: isTimeout ? 'run.timeout' : 'run.fail',
          payload: {
            function: opts.name,
            duration,
            error: error.message,
            error_type: error.constructor.name,
            timeout: isTimeout ? opts.timeout : undefined
          },
          timestamp: Date.now()
        });

        // Auto-retry if enabled and not a timeout
        if (sdk.autoRetry && !isTimeout && opts.retryCount < sdk.maxRetries) {
          opts.retryCount = (opts.retryCount || 0) + 1;
          console.log(`Sentinel: Retrying ${opts.name} (attempt ${opts.retryCount})`);
          return sdk.wrap(fn, opts).apply(this, args);
        }

        throw error;
      }
    };
  }

  // Track a step within a run (for loop detection)
  async step(runId, stepName, payload = {}) {
    await this.sendEvent({
      agent_id: this.agentId,
      run_id: runId,
      type: 'run.step',
      payload: {
        step: stepName,
        ...payload
      },
      timestamp: Date.now()
    });
  }

  // Track a tool call
  async toolCall(runId, toolName, payload = {}) {
    await this.sendEvent({
      agent_id: this.agentId,
      run_id: runId,
      type: 'tool.call',
      payload: {
        tool: toolName,
        ...payload
      },
      timestamp: Date.now()
    });
  }

  // Track a tool failure
  async toolFailure(runId, toolName, error, payload = {}) {
    await this.sendEvent({
      agent_id: this.agentId,
      run_id: runId,
      type: 'tool.failure',
      payload: {
        tool: toolName,
        error: error.message || error,
        ...payload
      },
      timestamp: Date.now()
    });
  }

  // Register this agent with Sentinel
  async register(name, config = {}) {
    try {
      const response = await fetch(`${this.endpoint}/agents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          id: this.agentId,
          name,
          config
        })
      });

      return await response.json();
    } catch (err) {
      console.error('Sentinel: Failed to register agent', err.message);
      return null;
    }
  }
}

// Singleton instance
let defaultInstance = null;

function getInstance(config) {
  if (!defaultInstance || config) {
    defaultInstance = new SentinelSDK(config);
  }
  return defaultInstance;
}

// Convenience methods
function init(config) {
  return getInstance(config).init(config);
}

function wrap(fn, options) {
  return getInstance().wrap(fn, options);
}

function step(runId, stepName, payload) {
  return getInstance().step(runId, stepName, payload);
}

function toolCall(runId, toolName, payload) {
  return getInstance().toolCall(runId, toolName, payload);
}

function toolFailure(runId, toolName, error, payload) {
  return getInstance().toolFailure(runId, toolName, error, payload);
}

module.exports = {
  SentinelSDK,
  getInstance,
  init,
  wrap,
  step,
  toolCall,
  toolFailure
};
