import { expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ExternalAnalystOperations } from '../../src/application/index.js';

// Capture the actual HTTP owner for injection without binding privileged port 80.
const servers:FastifyInstance[]=[];
const fastify = jest.fn(() => {
  const server=Fastify({logger:false});
  servers.push(server);
  return server;
});
jest.unstable_mockModule('fastify', () => ({default:fastify}));
const { createAnalystMcpServer } = await import('../../src/server/analyst-mcp-server.js');

it.each(['127.0.0.1', '::1'])('derives port-80 endpoint and exact request authority from one URL for %s', async host => {
  const listener = createAnalystMcpServer({
    startup:{mode:'external',host,port:80,principal:'test-client',token:'synthetic-token',tools:[]},
    binding:{project_identity_digest:'digest',project_name:'Synthetic project',analyst_policy:'analyst',principal:'test-client'},
    // GET admission terminates before consuming operations or context.
    operations:{} as ExternalAnalystOperations,
    context:()=>{throw new Error('Unexpected context consumption');},
    fatalPort:{publicationOutcomeUnknown(error):never {throw error;}},
    onOwnerFailure(error){throw error;},
  });
  const http=servers.at(-1)!;
  const authority=host==='::1'?'[::1]':host;
  expect(listener.endpoint).toBe(`http://${authority}/mcp/analyst/digest`);
  try {
    for(const [requestHost,statusCode] of [[authority,405],[`${authority}:80`,403],['localhost',403]] as const) {
      const response=await http.inject({method:'GET',url:'/mcp/analyst/digest',headers:{host:requestHost,authorization:'Bearer synthetic-token'}});
      expect(response.statusCode).toBe(statusCode);
    }
  } finally {await listener.cleanupForApplicationStop();}
});
