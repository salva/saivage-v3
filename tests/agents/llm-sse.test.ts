import {describe,expect,it} from '@jest/globals';
import {IncrementalSseReader,SSE_DONE,type SseOutput} from '../../src/agents/llm-sse.js';

const encoder=new TextEncoder();

function parse(chunks:Uint8Array[]):SseOutput[]{const reader=new IncrementalSseReader();return chunks.flatMap((chunk)=>reader.push(chunk)).concat(reader.finish());}
function everySplit(text:string):Uint8Array[][]{const bytes=encoder.encode(text);return Array.from({length:bytes.length+1},(_,split)=>[bytes.slice(0,split),bytes.slice(split)]);}

describe('incremental SSE reader',()=>{
  it.each(['data: one\n\n','data: one\r\n\r\n','data: one\r\r','event: x\rdata: one\n\r'])('is invariant at every byte split for %p',(text)=>{
    for(const chunks of everySplit(text))expect(parse(chunks)).toEqual([{event:text.startsWith('event:')?'x':'message',dataText:'one'}]);
  });

  it('handles split multibyte UTF-8, pending CR, and intentional EOF dispatch',()=>{
    for(const chunks of everySplit('data: café\r'))expect(parse(chunks)).toEqual([{event:'message',dataText:'café'}]);
    expect(parse([encoder.encode('data: suffix')])).toEqual([{event:'message',dataText:'suffix'}]);
    expect(parse([encoder.encode('data: once\n\n')])).toEqual([{event:'message',dataText:'once'}]);
  });

  it('implements exact event/data field semantics',()=>{
    const text=': comment\nevent: first\nevent:\ndata\ndata: \ndata:  two:three  \nid: ignored\n\n';
    expect(parse([encoder.encode(text)])).toEqual([{event:'message',dataText:'\n\n two:three  '}]);
    expect(parse([encoder.encode('data: [DONE]\n\ndata:  [DONE]\n\n')])).toEqual([SSE_DONE,{event:'message',dataText:' [DONE]'}]);
  });

  it('fails malformed UTF-8 and impossible post-finish use',()=>{
    const malformed=new IncrementalSseReader();malformed.push(Uint8Array.of(0xc3));expect(()=>malformed.finish()).toThrow();
    const finished=new IncrementalSseReader();finished.finish();expect(()=>finished.finish()).toThrow();expect(()=>finished.push(new Uint8Array())).toThrow();
  });
});
