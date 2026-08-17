import { describe, expect, it } from '@jest/globals';
import { compilePromptTemplate, renderCompiledPrompt } from '../../src/utils/prompt-api.js';

const templateName='test-template';
const compile=(text:string,kind:'global-agent'|'workflow-agent'|'process'='workflow-agent',fragments:Record<string,string>={})=>compilePromptTemplate({host:kind==='global-agent'?{kind}:{kind,cardType:'code'},name:templateName,path:'host.md',text,resolveFragment:(id)=>{if(!(id in fragments))throw Object.assign(new Error(`missing ${id}`),{code:'ENOENT'});return{path:`fragments/${id}.md`,text:fragments[id]!};}});

describe('prompt template compiler',()=>{
  it('renders direct repeated literal fragments in semantic order',()=>{
    const compiled=compile('A {{> contract}} B {{> detail}} C {{> detail}}','workflow-agent',{contract:'contract',detail:'detail'});
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'code'},templateName,compiled,{})).toBe('A contract B detail C detail');
    expect(Object.isFrozen(compiled.tokens)).toBe(true);
  });
  it('rejects malformed, nested, missing, and host-inapplicable syntax',()=>{
    expect(()=>compile('Use }}')).toThrow(/stray/);
    expect(()=>compile('{{outer {{inner}}')).toThrow(/nested/);
    expect(()=>compile('{{> missing}}')).toThrow(/missing/);
    expect(()=>compile('{{> outer}}','workflow-agent',{outer:'{{> inner}}'})).toThrow(/contains a fragment include/);
    expect(()=>compile('{{contractDescription}}','process')).toThrow(/inapplicable/);
    expect(()=>compile('{{cardType}}','global-agent')).toThrow(/inapplicable/);
  });
  it('rejects runtime placeholders from configured agent templates',()=>{
    for (const placeholder of ['projectContext','cardId','cardTitle','cardBrief','cardType','contractDescription','toolList'])
      expect(()=>compile(`{{${placeholder}}}`)).toThrow(/unknown or inapplicable/);
  });
});
