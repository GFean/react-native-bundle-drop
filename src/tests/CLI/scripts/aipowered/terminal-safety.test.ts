import {
  assertSafeProviderPlan,
  escapeTerminalControls,
  hasUnsafeTerminalControl,
} from '../../../../CLI/scripts/aipowered/terminal-safety';
import type { AiSetupPlanResponse } from '../../../../CLI/scripts/aipowered/types';

const safePlan = (): AiSetupPlanResponse => ({
  confidence: 'high',
  summary: 'Ready',
  warnings: ['Review changes'],
  actions: [{ type: 'run_doctor', reason: 'Validate', requiresConfirmation: false }],
  changes: [{
    file: 'app.config.js',
    originalSha256: 'hash',
    updated: 'export default {};\n',
    reason: 'Configure',
    confidence: 'high',
    decisionType: 'review_only_patch',
  }],
});

describe('AI setup terminal safety', () => {
  it('allows ordinary text, tabs, newlines, and CRLF without rewriting it', () => {
    const value = 'summary\tline one\r\nline two\n';

    expect(hasUnsafeTerminalControl(value)).toBe(false);
    expect(escapeTerminalControls(value)).toBe(value.replace('\r', '\\r'));
    expect(() => assertSafeProviderPlan(safePlan())).not.toThrow();
  });

  it.each([
    ['summary', (plan: AiSetupPlanResponse) => { plan.summary = 'clear\x1b[2J'; }],
    ['warning', (plan: AiSetupPlanResponse) => { plan.warnings[0] = 'overwrite\rline'; }],
    ['action reason', (plan: AiSetupPlanResponse) => { plan.actions[0].reason = 'bidi\u202E'; }],
    ['change reason', (plan: AiSetupPlanResponse) => { plan.changes[0].reason = 'bell\x07'; }],
    ['change content', (plan: AiSetupPlanResponse) => { plan.changes[0].updated = 'bad\x1b[2J'; }],
    ['change content U+2028', (plan: AiSetupPlanResponse) => {
      plan.changes[0].updated = 'comment\u2028module = { exports: {} }';
    }],
    ['change content U+2029', (plan: AiSetupPlanResponse) => {
      plan.changes[0].updated = 'comment\u2029module = { exports: {} }';
    }],
  ])('rejects unsafe controls in provider %s', (_label, mutate) => {
    const plan = safePlan();
    mutate(plan);
    expect(() => assertSafeProviderPlan(plan)).toThrow('unsafe terminal controls');
  });

  it('renders controls as inert visible escape markers', () => {
    expect(escapeTerminalControls('a\x1b[2J\rb\u202Ec\u2028d\u2029')).toBe(
      'a\\x1b[2J\\rb\\u202ec\\u2028d\\u2029',
    );
  });

  it('rejects provider text containing a private Bundle Drop credential before output', () => {
    const plan = safePlan();
    plan.summary = 'Use bdp_proj_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
    expect(() => assertSafeProviderPlan(plan)).toThrow('private Bundle Drop credential');
  });

  it.each([
    ['non-object plan', () => null],
    ['missing typed arrays', () => ({ confidence: 'high', summary: 'Ready' })],
    ['invalid action entry', () => {
      const plan: any = safePlan();
      plan.actions = [null];
      return plan;
    }],
    ['invalid change entry', () => {
      const plan: any = safePlan();
      plan.changes = [null];
      return plan;
    }],
    ['non-text summary', () => {
      const plan: any = safePlan();
      plan.summary = 42;
      return plan;
    }],
  ])('rejects malformed provider structure: %s', (_label, buildPlan) => {
    expect(() => assertSafeProviderPlan(buildPlan())).toThrow('AI setup response');
  });

  it.each([
    ['plan confidence', (plan: any) => { plan.confidence = 'certain'; }],
    ['action type', (plan: any) => { plan.actions[0].type = 'delete_project'; }],
    ['confirmation flag', (plan: any) => { plan.actions[0].requiresConfirmation = 'false'; }],
    ['change confidence', (plan: any) => { plan.changes[0].confidence = true; }],
    ['change decision', (plan: any) => { plan.changes[0].decisionType = 'auto'; }],
    ['original hash', (plan: any) => { plan.changes[0].originalSha256 = false; }],
  ])('rejects an invalid provider %s type before display or apply', (_label, mutate) => {
    const plan: any = safePlan();
    mutate(plan);
    expect(() => assertSafeProviderPlan(plan)).toThrow('AI setup response contains');
  });
});
