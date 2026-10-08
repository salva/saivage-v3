import { describe,expect,it,jest } from '@jest/globals';
import Fastify from 'fastify';
import { operatorApiContracts,type OperatorApiOperationId,type OperatorRouteContract } from '../../src/contracts/operator-api.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { createEventLog } from '../../src/observability/index.js';

const cases=[
  {operationId:'mcp.start',url:'/api/mcp/servers/browser/start',body:{serverName:'browser',status:'running',toolCount:1}},
  {operationId:'mcp.stop',url:'/api/mcp/servers/browser/stop',body:{serverName:'browser',status:'stopped',toolCount:0}},
  {operationId:'agents.currentInstructions',url:'/api/agents/agent%3Aanalyst%3Aglobal/current-instructions',body:{session_id:'agent:analyst:global',basis:'server_loaded_configuration',scope:{kind:'global'},bindings:[{kind:'global',instructions:'Safe current instructions'}]}},
  {operationId:'events.list',url:'/api/events',body:{events:[],total:0}},
  {operationId:'processes.list',url:'/api/processes',body:{processes:[]}},
  {operationId:'controlActions.list',url:'/api/control-actions',body:{control_actions:[],total:0}},
] as const satisfies ReadonlyArray<{operationId:OperatorApiOperationId;url:string;body:unknown}>;
function mount(authPolicy:AuthPolicy){const fastify=Fastify({logger:false});const contracts:Record<string,OperatorRouteContract>={};const handlers:Record<string,()=>{body:unknown}>={};for(const value of cases){contracts[value.operationId]=operatorApiContracts[value.operationId];handlers[value.operationId]=jest.fn(()=>({body:value.body}));}contracts['health.liveness']=operatorApiContracts['health.liveness'];handlers['health.liveness']=jest.fn(()=>({body:{status:'ok',version:'test',project:'test'}}));new ContractRuntime({authPolicy,eventLogger:createEventLog('.'),fatalPort:testApplicationFatalPort}).mount(fastify,contracts,handlers);return{fastify,handlers};}

describe('current operator route authentication',()=>{
  it('authenticates protected routes before request validation or handler entry',async()=>{const{fastify,handlers}=mount(new AuthPolicy({apiToken:'route-token'}));try{for(const value of cases){const method=operatorApiContracts[value.operationId].method;const payload=method==='POST'?{}:undefined;const missing=await fastify.inject({method,url:value.url,payload});expect(missing.statusCode).toBe(401);expect(handlers[value.operationId]).not.toHaveBeenCalled();const wrong=await fastify.inject({method,url:value.url,payload,headers:{authorization:'Bearer wrong'}});expect(wrong.statusCode).toBe(401);const admitted=await fastify.inject({method,url:value.url,payload,headers:{authorization:'Bearer route-token'}});expect(admitted.statusCode).toBe(200);expect(admitted.json()).toEqual(value.body);}const malformed=await fastify.inject({method:'GET',url:'/api/events?limit=-1'});expect(malformed.statusCode).toBe(401);}finally{await fastify.close();}});
  it('keeps health public and admits protected routes without headers only when auth is disabled',async()=>{const secured=mount(new AuthPolicy({apiToken:'route-token'}));try{expect((await secured.fastify.inject({method:'GET',url:'/health'})).statusCode).toBe(200);}finally{await secured.fastify.close();}const open=mount(new AuthPolicy());try{for(const value of cases){const method=operatorApiContracts[value.operationId].method;expect((await open.fastify.inject({method,url:value.url,payload:method==='POST'?{}:undefined})).statusCode).toBe(200);}}finally{await open.fastify.close();}});
});
