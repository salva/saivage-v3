import { describe, expect, it } from 'vitest';
import { presentToolResult } from '../utils/tool-presenters';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import ToolSemanticSection from '../components/conversation/ToolSemanticSection.vue';

describe('observed source results', () => {
  it('uses the actual semantic section and InlineParts router link for original-source navigation', async () => {
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{template:'<div />'}},{path:'/files',name:'files',component:{template:'<div />'}}]});
    await router.push('/');await router.isReady();
    const view=presentToolResult(JSON.stringify({success:true,data:{collections:[],coverage:{exhaustive:false},hits:[{rank:1,memberships:[{collection:'docs',path:'docs/guide.md'}],excerpt:'Safe source reference',transformed:false,excerpt_truncated:false,location:'unavailable',channels:['lexical']}]}}),{tool:'query_observed_collections'});
    const section=view.sections.find(section=>section.title==='Read original source')!;
    const wrapper=mount(ToolSemanticSection,{props:{section},global:{plugins:[router]}});
    try {
      await wrapper.get('a.inline-part-file').trigger('click');await flushPromises();
      expect(router.currentRoute.value.name).toBe('files');
      expect(router.currentRoute.value.query.path).toBe('docs/guide.md');
      expect(router.currentRoute.value.query.preview).toBe('source');
      expect(router.currentRoute.value.query.root).toBeUndefined();
    } finally {wrapper.unmount();}
  });
  it('shows partial/channel/transformation facts and ordinary original navigation', () => {
    const view = presentToolResult(JSON.stringify({ success: true, data: {
      collections: [{ name: 'docs', queryability: 'available', coverage: 'incomplete', limitations: ['semantic_fields_absent'] }],
      hits: [{ rank: 1, memberships: [{ collection: 'docs', path: 'docs/guide.md' }], excerpt: 'Safe excerpt',
        transformed: true, location: 'unavailable', channels: ['lexical'] }],
      coverage: { exhaustive: false, failed_channels: [], unavailable_channels: ['neural'], postfilter_removals: true,
        candidate_limit_reached: true, output_truncated: false, limitations: ['eligible_results_may_be_starved'] },
    } }), { tool: 'query_observed_collections' });
    const body = JSON.stringify(view.sections);
    expect(body).toContain('semantic_fields_absent'); expect(body).toContain('eligible_results_may_be_starved');
    expect(body).toContain('Safe excerpt'); expect(body).toContain('transformed');
    const membership = view.sections.find((s) => s.title === 'Read original source');
    expect(JSON.stringify(membership)).toContain('docs/guide.md');
    expect(view.outcome).toContain('Advisory observation');
  });
  it('does not report observation success on a safe query failure', () => {
    const view = presentToolResult(JSON.stringify({ success: false, error: 'Observed source query unavailable or not permitted.' }), { tool: 'query_observed_collections' });
    expect(view.outcome).toBe('Failed');
    expect(JSON.stringify(view)).not.toContain('Advisory observation');
  });
  it('only links observed project-relative memberships, not arbitrary historical paths or URLs', () => {
    const view=presentToolResult(JSON.stringify({success:true,data:{hits:[{memberships:[
      {collection:'docs',path:'/etc/passwd'},{collection:'docs',path:'../outside.md'},
      {collection:'docs',path:'https://example.invalid/source'}, {collection:'docs',path:'docs/guide.md'},
    ]}]}}),{tool:'query_observed_collections'});
    const parts=view.sections.flatMap(s=>s.items??[]).flatMap(s=>s.fields??[]).flatMap(f=>f.parts);
    expect(parts.filter(p=>p.kind==='source-file')).toEqual([{kind:'source-file',path:'docs/guide.md'}]);
    const read=presentToolResult(JSON.stringify({success:true,data:{path:'docs/guide.md',content:'ordinary read'}}),{tool:'read'});
    expect(JSON.stringify(read)).not.toContain('source-file');
  });
});
