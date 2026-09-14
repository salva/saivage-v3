import { mount } from '@vue/test-utils';
import { describe,expect,it } from 'vitest';
import StatePanel from '../components/debug/StatePanel.vue';

const props={runtime:null,runtimeLoaded:true,runtimeLoading:false,runtimeError:null,runtimeRefreshing:false,runtimeRefreshError:null,currentCardId:null};
const base={agent_name:'oversight',session_id:'agent:oversight:global',enabled:true,eligible:false,eligibility_reason:'stopped' as const,state:'unavailable' as const,next_nominal_due:null,last_attempt:null,last_successful_at:null,service_epoch:'2026-09-14T00:00:00.000Z'};

describe('Debug Project Oversight diagnostic',()=>{
  it.each([
    ['unavailable',base],
    ['disabled',{...base,enabled:false,eligibility_reason:'disabled' as const}],
    ['waiting',{...base,eligible:true,eligibility_reason:null,state:'waiting' as const,next_nominal_due:'2026-09-14T02:00:00.000Z'}],
    ['checking',{...base,eligibility_reason:'settling_previous_check' as const,state:'checking' as const,last_attempt:{outcome:'cancelled' as const,settled_at:'2026-09-14T01:00:00.000Z'}}],
  ])('renders %s without inventing absent timestamps',(_label,oversight)=>{const wrapper=mount(StatePanel,{props:{...props,oversight}});const text=wrapper.get('[data-testid="debug-oversight-state"]').text();expect(text).toContain(oversight.state);expect(text).toContain('Project Oversight');expect(text).toContain(oversight.session_id);expect(text).toContain('Service epoch:');expect(text).not.toContain('1/1/1970');if(!oversight.last_successful_at)expect(text).toContain('Last success:none');});
});
