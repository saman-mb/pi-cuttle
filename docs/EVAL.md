# Evaluation Guide

This document describes the pi-cuttle evaluation pipeline using Promptfoo.

## Quick Start

```bash
# Run the full evaluation suite
npm run eval:promptfoo

# View results in browser
npm run eval:promptfoo:view

# Convert existing corpus to Promptfoo format
npm run eval:convert
```

## Fixture Format

Fixtures are defined in `eval/promptfoo.yaml` in Promptfoo-compatible YAML format. The legacy `eval/corpus.jsonl` can be converted to `eval/corpus-promptfoo.yaml` via `npm run eval:convert`.

```yaml
tests:
  - vars:
      prompt: "rename the variable `usrCnt` to `userCount`"
    assert:
      - type: javascript
        value: output.tier === 'local'
      - type: javascript
        value: output.thinkingLevel === 'off'
    metadata:
      category: complexity
      expectedScoreRange: [0, 0.2]
```

### Test Fields

- **vars.prompt**: The user prompt to evaluate
- **assert**: Array of assertions that must pass
  - `type: javascript`: Custom JavaScript assertion evaluating the routing output
  - Common checks: `output.tier`, `output.thinkingLevel`, `output.flavor`, `output.decision`
- **metadata**: Optional test metadata for categorization and debugging

### Output Schema

The custom provider (`eval/pi-cuttle-provider.ts`) returns a JSON object with:

```typescript
interface RoutingOutput {
  tier: "local" | "cloud";
  modelId: string;
  flavor: "auto" | "local" | "cloud" | "fast-local" | "big-local" | "orchestrator";
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  decision: {
    source: "classifier" | "heuristic" | "pin";
    reason: string;
    score?: number;
  };
  isSubagent: boolean;
  localBiasApplied: boolean;
  userCeilingRespected: boolean;
  requestedThinkingLevel?: string;
  effectiveThinkingLevel: string;
  complexityScore?: number;
}
```

## Fixture Categories

The test suite covers all pi-cuttle 0.5.0 features:

1. **Complexity Scoring** (12 fixtures): Simple vs complex prompts
2. **Thinking-Level Clamping** (8 fixtures): Prompts at various complexity levels
3. **Subagent Policy Override** (6 fixtures): Subagent role detection
4. **Flavor Routing** (16 fixtures):
   - big-local (4): Large local model orchestration
   - orchestrator (4): Architecture and planning tasks
   - fast-local (4): Quick validation tasks
   - auto (4): Default routing behavior
5. **/cuttle why Support** (4 fixtures): Decision explainability
6. **localBias Configuration** (3 fixtures): Local preference tuning
7. **enforceUserCeiling** (3 fixtures): User thinking level caps
8. **Edge Cases** (4 fixtures): Empty prompts, minimal input

Total: 56 fixtures

## Custom Provider

The provider (`eval/pi-cuttle-provider.ts`) mocks the pi ExtensionContext and calls `routeRequest()` directly. No live model server is needed for routing decisions.

### Mocked Models

- **lmstudio/meta/muse-glimmer**: Small local model (131K context)
- **lmstudio/prism-ml/bonsai-27b**: Large local model (262K context)
- **opencode-go/deepseek-v4.1-flash**: Cloud model (1M context)

### Configuration

The provider uses default router config with:
- Heuristic classifier (no live model required)
- Local bias: 0.1
- Thinking levels enabled with enforceUserCeiling: true
- Catalog: 2 local models, 1 cloud model

## Migration from Legacy Eval

The legacy eval system (`eval/run.ts`, `eval/score.ts`, `eval/corpus.jsonl`) is still available but deprecated. To migrate:

1. Run `npm run eval:convert` to convert corpus.jsonl to Promptfoo format
2. Review generated fixtures in `eval/corpus-promptfoo.yaml`
3. Add category-specific tests as needed
4. Run both systems in parallel during transition

## Observability and Feedback Loop

Routing decisions are sent to LangFuse when `observability.enabled` is true in
`pi-cuttle.json` (see `docs/CONFIG.md`). Each trace contains:

- Chosen tier, model, flavor, and thinking level
- Complexity score and decision source
- Subagent flag and policy overrides in effect

To use this for continuous improvement:

1. Start LangFuse: `npm run langfuse:up`
2. Enable observability in your pi-cuttle config
3. Use the LangFuse UI to mark misrouted traces
4. Export annotations and add them to `eval/promptfoo.yaml` (tracked in #90)

## CI Integration

Add to GitHub Actions workflow:

```yaml
- name: Run Promptfoo eval
  run: npm run eval:promptfoo

- name: Upload results
  uses: actions/upload-artifact@v4
  with:
    name: eval-results
    path: eval/results.json
```

## Troubleshooting

- **"Provider not found"**: Ensure `eval/pi-cuttle-provider.ts` exists and exports a default function
- **TypeScript errors**: Run `npm run typecheck` to verify types
- **Fixture syntax errors**: Validate YAML with a linter or use `promptfoo view` to debug
- **Missing assertions**: Check that output schema matches expected fields
