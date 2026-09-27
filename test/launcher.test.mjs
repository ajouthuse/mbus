import test from 'node:test';
import assert from 'node:assert/strict';
import { agentArgs, defaultAgents, launchOptions } from '../scripts/launch-agents.mjs';

const endpoint = 'http://127.0.0.1:7331/mcp';
const server = 'mbus_launcher_7331';
const prompt = 'Join room "parser & review"; preserve $variables and apostrophes\'s.';
const config = 'C:\\workspace with spaces\\mcp.json';

test('default run selects the requested eight agents and engine without prompts', () => {
  assert.deepEqual(launchOptions([]), { base: 'http://127.0.0.1:7331', dryRun: false, interactive: false, room: 'engine' });
  const agents = defaultAgents();
  assert.deepEqual(agents.map(a => [a.provider, a.model, a.effort]), [
    ['codex', 'gpt-6-astra', 'medium'], ['codex', 'gpt-6-sol', 'medium'],
    ['codex', 'gpt-6-sol', 'medium'], ['codex', 'gpt-6-luna', 'medium'],
    ['claude', 'claude-opus-5-5', 'medium'], ['claude', 'claude-opus-5-5', 'medium'],
    ['claude', 'claude-fable-5-1', 'medium'], ['claude', 'sonnet', 'high'],
  ]);
  for (const agent of agents) {
    const args = agentArgs(agent, endpoint, server, prompt, config, 'bridge.json');
    assert.equal(args[args.indexOf('--model') + 1], agent.model);
    if (agent.provider === 'codex') assert.ok(args.includes(`model_reasoning_effort="${agent.effort}"`));
    else assert.equal(args[args.indexOf('--effort') + 1], agent.effort);
  }
});

test('custom mode, room override and dry run remain explicit; malformed options fail', () => {
  assert.equal(launchOptions(['--interactive']).room, undefined);
  assert.deepEqual(launchOptions(['--room', 'art', '--dry-run', '--url', 'http://127.0.0.1:7332']), {
    room: 'art', dryRun: true, interactive: false, base: 'http://127.0.0.1:7332',
  });
  assert.equal(launchOptions(['--interactive', '--room', 'engine']).room, 'engine');
  for (const args of [['--room'], ['--room', '--dry-run'], ['--url'], ['--unknown']]) assert.throws(() => launchOptions(args));
});

test('Codex receives intact TOML overrides and one literal prompt argument', () => {
  assert.deepEqual(agentArgs({ provider: 'codex', model: 'chosen-model', effort: 'high' }, endpoint, server, prompt, config), [
    '--dangerously-bypass-approvals-and-sandbox',
    '--model', 'chosen-model', '-c', 'model_reasoning_effort="high"',
    '-c', 'mcp_servers.mbus_launcher_7331.url="http://127.0.0.1:7331/mcp"',
    '-c', 'mcp_servers.mbus_launcher_7331.enabled=true', '--', prompt,
  ]);
});

test('Claude uses an MCP config file and an interactive positional prompt', () => {
  assert.deepEqual(agentArgs({ provider: 'claude', model: 'opus', effort: 'max' }, endpoint, server, prompt, config), [
    '--dangerously-skip-permissions',
    '--model', 'opus', '--effort', 'max', '--mcp-config', config, '--', prompt,
  ]);
});

test('Antigravity uses its interactive prompt flag', () => {
  assert.deepEqual(agentArgs({ provider: 'agy', model: 'chosen-model', effort: 'low' }, endpoint, server, prompt, config), [
    '--dangerously-skip-permissions',
    '--model', 'chosen-model', '--effort', 'low', '--prompt-interactive', prompt,
  ]);
});

test('empty selections retain provider defaults', () => {
  for (const provider of ['claude', 'codex', 'agy']) {
    const args = agentArgs({ provider, model: '', effort: '' }, endpoint, server, prompt, config);
    assert.ok(!args.includes('--model'));
    assert.ok(!args.includes('--effort'));
    assert.ok(!args.some(arg => arg.startsWith('model_reasoning_effort=')));
  }
});

test('launcher configures Claude channels and isolated Codex stdio bridges', () => {
  const bridgePath = 'C:/path with spaces/agent.bridge.json';
  const claude = agentArgs({ provider: 'claude' }, endpoint, server, prompt, config, bridgePath);
  assert.ok(claude.includes('--dangerously-load-development-channels'));
  assert.ok(claude.includes(`server:${server}`));
  const codex = agentArgs({ provider: 'codex' }, endpoint, server, prompt, config, bridgePath);
  const override = codex.find(arg => arg.startsWith(`mcp_servers.${server}=`));
  assert.ok(override.includes('agent-bridge.mjs'));
  assert.ok(override.includes(bridgePath));
  assert.ok(!override.includes('url='));
});
