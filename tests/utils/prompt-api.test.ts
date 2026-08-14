import { describe, expect, it } from '@jest/globals';
import { compilePromptTemplate, renderCompiledPrompt } from '../../src/utils/prompt-api.js';
import type { AgentName } from '../../src/schemas/index.js';

const name='executor' as AgentName;
const compile=(text:string,policy:'global-agent'|'workflow-agent'|'process'='workflow-agent',fragments:Record<string,string>={})=>compilePromptTemplate({cardType:policy==='global-agent'?'global':'code',name,path:'host.md',text,policy,resolveFragment:(id)=>{if(!(id in fragments))throw Object.assign(new Error(`missing ${id}`),{code:'ENOENT'});return{path:`fragments/${id}.md`,text:fragments[id]!};}});

describe('prompt template compiler',()=>{
  it('renders direct repeated fragments in semantic order and counts the expanded contract',()=>{
    const compiled=compile('A {{> contract}} B {{> detail}} C {{> detail}}','workflow-agent',{contract:'{{contractDescription}}',detail:'{{cardType}}'});
    expect(renderCompiledPrompt('code',name,compiled,{contractDescription:'contract',cardType:'code'})).toBe('A contract B code C code');
    expect(Object.isFrozen(compiled.tokens)).toBe(true);
  });
  it('rejects malformed, nested, missing, and host-inapplicable syntax',()=>{
    expect(()=>compile('Use }}')).toThrow(/stray/);
    expect(()=>compile('{{outer {{inner}}')).toThrow(/nested/);
    expect(()=>compile('{{> missing}} {{contractDescription}}')).toThrow(/missing/);
    expect(()=>compile('{{> outer}} {{contractDescription}}','workflow-agent',{outer:'{{> inner}}'})).toThrow(/contains a fragment include/);
    expect(()=>compile('{{contractDescription}}','process')).toThrow(/inapplicable/);
    expect(()=>compile('{{cardType}}','global-agent')).toThrow(/inapplicable/);
  });
  it('requires exactly one workflow contract after expansion',()=>{
    expect(()=>compile('none')).toThrow(/found 0/);
    expect(()=>compile('{{> contract}} {{contractDescription}}','workflow-agent',{contract:'{{contractDescription}}'})).toThrow(/found 2/);
  });
});
