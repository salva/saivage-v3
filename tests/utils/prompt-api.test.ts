import { describe, expect, it } from '@jest/globals';
import { compilePromptTemplate, renderCompiledPrompt } from '../../src/utils/prompt-api.js';

const templateName='test-template';
const compile=(text:string,kind:'global-agent'|'workflow-agent'|'process'='workflow-agent',fragments:Record<string,string>={})=>compilePromptTemplate({host:kind==='global-agent'?{kind}:{kind,cardType:'code'},name:templateName,path:'host.md',text,resolveFragment:(id)=>{if(!(id in fragments))throw Object.assign(new Error(`missing ${id}`),{code:'ENOENT'});return{path:`fragments/${id}.md`,text:fragments[id]!};}});

describe('prompt template compiler',()=>{
  it('renders direct repeated fragments in semantic order and counts the expanded contract',()=>{
    const compiled=compile('A {{> contract}} B {{> detail}} C {{> detail}}','workflow-agent',{contract:'{{contractDescription}}',detail:'detail'});
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'code'},templateName,compiled,{contractDescription:'contract'})).toBe('A contract B detail C detail');
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
  it('rejects removed dynamic placeholders from every former host',()=>{
    for(const token of ['projectContext','toolList'])expect(()=>compile(`{{${token}}}`,'global-agent')).toThrow(/inapplicable/);
    for(const token of ['cardId','cardTitle','cardBrief','cardType','toolList'])expect(()=>compile(`{{contractDescription}} {{${token}}}`,'workflow-agent')).toThrow(/inapplicable/);
  });
  it('requires exactly one workflow contract after expansion',()=>{
    expect(()=>compile('none')).toThrow(/found 0/);
    expect(()=>compile('{{> contract}} {{contractDescription}}','workflow-agent',{contract:'{{contractDescription}}'})).toThrow(/found 2/);
  });
});
