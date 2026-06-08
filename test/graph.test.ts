import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentState } from '../src/agent/state';

// Importing the graph pulls in the agent nodes, which construct the Claude
// singleton; provide a dummy key so the import succeeds.
process.env.ANTHROPIC_API_KEY = 'test-key';

async function loadGraph() {
  return import('../src/agent/graph');
}

function stateWith(partial: Partial<AgentState>): AgentState {
  return {
    messages: [],
    conversationId: 'c1',
    toolResults: {},
    shouldContinue: true,
    iterations: 0,
    metadata: {},
    ...partial,
  } as AgentState;
}

test('shouldContinueToTools continues while under the iteration cap', async () => {
  const { shouldContinueToTools } = await loadGraph();
  assert.equal(
    shouldContinueToTools(stateWith({ shouldContinue: true, iterations: 1 })),
    'continue'
  );
});

test('shouldContinueToTools ends when the model is done', async () => {
  const { shouldContinueToTools } = await loadGraph();
  assert.equal(
    shouldContinueToTools(stateWith({ shouldContinue: false, iterations: 1 })),
    'end'
  );
});

test('shouldContinueToTools ends once the iteration cap is reached even if the model wants more tools', async () => {
  const { shouldContinueToTools, MAX_ITERATIONS } = await loadGraph();
  assert.equal(
    shouldContinueToTools(
      stateWith({ shouldContinue: true, iterations: MAX_ITERATIONS })
    ),
    'end'
  );
});
