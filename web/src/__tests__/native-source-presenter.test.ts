import { expect, it } from 'vitest';
import { presentToolResult } from '../utils/tool-presenters';

it('presents a private checkpoint as source evidence, not delivery or product acceptance', () => {
  const view = presentToolResult(JSON.stringify({success:true,data:{branch_ref:'refs/heads/saivage/fixture/project',observed_tip:'a'.repeat(40)}}), {tool:'checkpoint_source'});
  expect(view.outcome).toContain('Not product acceptance');
  expect(JSON.stringify(view.sections)).toContain('observed tip');
  const failed = presentToolResult(JSON.stringify({success:false,error:'Native source ownership mismatch'}), {tool:'checkpoint_source'});
  expect(failed.outcome).toBe('Failed · Source checkpoint refused');
  expect(JSON.stringify(failed)).not.toContain('Source checkpoint recorded');
});
