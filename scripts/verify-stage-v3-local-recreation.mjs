import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = '/work/saivage-v3';
const reportDir = join(repoRoot, '.saivage/stages/stage-v3-006-verification-live-recreation/reports');
const isolatedRoot = join(repoRoot, '.saivage-work/stage-v3-006-local-recreation');
const fixtureDir = join(isolatedRoot, 'fixtures');
const sourceDir = join(isolatedRoot, 'source-artifacts');
const snapshotsDir = join(reportDir, 't2-local-recreation-snapshots');
const token = 'stage-v3-local-token';

mkdirSync(reportDir, { recursive: true });
rmSync(isolatedRoot, { recursive: true, force: true });
rmSync(snapshotsDir, { recursive: true, force: true });
mkdirSync(fixtureDir, { recursive: true });
mkdirSync(sourceDir, { recursive: true });
mkdirSync(snapshotsDir, { recursive: true });

const { initProjectTree } = await import(pathToFileURL(join(repoRoot, 'dist/src/utils/file-tree.js')).href);
const { Runtime } = await import(pathToFileURL(join(repoRoot, 'dist/src/utils/runtime.js')).href);
const { FakeAgentAdapter } = await import(pathToFileURL(join(repoRoot, 'dist/src/utils/fake-agent.js')).href);
const { releaseLock } = await import(pathToFileURL(join(repoRoot, 'dist/src/utils/runtime-lock.js')).href);
const { registerCardRoutes } = await import(pathToFileURL(join(repoRoot, 'dist/src/server/routes/cards.js')).href);
const { registerChatsFilesDebugRoutes } = await import(pathToFileURL(join(repoRoot, 'dist/src/server/routes/chats-files-debug.js')).href);
const authPlugin = (await import(pathToFileURL(join(repoRoot, 'dist/src/server/auth.js')).href)).default;

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function snapshotJson(name, value) {
  writeJson(join(snapshotsDir, name), value);
}

function createFixture(name, fixture) {
  writeJson(join(fixtureDir, `${name}.json`), fixture);
}

initProjectTree(isolatedRoot);

writeFileSync(join(isolatedRoot, '.saivage', 'saivage.json'), JSON.stringify({
  server: { port: 0, host: '127.0.0.1' },
  providers: { test: { apiKey: 'secret-key' } },
  models: { default: ['test-model'] },
}, null, 2));
writeFileSync(join(isolatedRoot, '.saivage', 'auth-profiles.json'), JSON.stringify({ token: 'top-secret' }, null, 2));

writeFileSync(join(sourceDir, 'artifact-note.txt'), 'planner control local recreation artifact\n', 'utf-8');
writeFileSync(join(sourceDir, 'attachment-output.txt'), 'generated attachment preview\n', 'utf-8');
writeFileSync(join(sourceDir, 'binary.bin'), Buffer.from([0, 159, 146, 150, 0, 1, 2, 3]));

const now = new Date().toISOString();
createFixture('project-parent', {
  name: 'project-parent',
  planner: [
    {
      status: 'done',
      created_cards: [
        {
          id: 'goal-parent-1',
          type: 'goal',
          title: 'Initial top-level goal',
          description: 'Create first top-level goal and let it discover more work.',
          status: 'backlog',
          depends_on: [],
          priority: 1,
        },
      ],
      summary: 'Initial project planning created one top-level goal.',
    },
    {
      status: 'done',
      created_cards: [
        {
          id: 'goal-parent-2',
          type: 'goal',
          title: 'Follow-up top-level goal',
          description: 'Project planner resumed and created additional work after the first goal completed.',
          status: 'backlog',
          depends_on: [],
          priority: 2,
        },
      ],
      summary: 'Project planner resumed and created a second top-level goal.',
    },
    {
      status: 'done',
      created_cards: [],
      summary: 'Project planner resumed again and confirmed no further work.',
    },
  ],
  reviewer: [
    {
      assessment: {
        id: 'review-project',
        goal_card_id: 'project',
        reviewer_session_id: 'rev-project',
        result: 'pass',
        summary: 'Project-level planning created the needed follow-up work.',
        achieved: ['Created goal-parent-1', 'Created goal-parent-2 after replanning'],
        missing: [],
        evidence_card_ids: ['goal-parent-1', 'goal-parent-2'],
        created_at: now,
      },
    },
  ],
});
createFixture('goal-two-leaves', {
  name: 'goal-two-leaves',
  planner: [
    {
      status: 'done',
      created_cards: [
        {
          id: 'code-parent-1',
          type: 'code',
          title: 'Artifact-producing leaf',
          description: 'Produce retained artifact/attachment evidence and malformed parse fallback evidence.',
          status: 'backlog',
          depends_on: [],
          priority: 1,
        },
        {
          id: 'code-parent-2',
          type: 'code',
          title: 'Second leaf after dependency',
          description: 'Execute after code-parent-1 to complete the first goal.',
          status: 'backlog',
          depends_on: ['code-parent-1'],
          priority: 2,
        },
      ],
      summary: 'Created two child cards and declared done.',
    },
  ],
  executor: {
    'code-parent-1': {
      card_id: 'code-parent-1',
      status: 'done',
      result: {
        generated_files: [
          '.saivage-work/cards/code-parent-1/artifacts/artifact-note.txt',
          '.saivage-work/cards/code-parent-1/attachments/attachment-output.txt',
          '.saivage/saivage.json',
          '../outside.txt',
          '/tmp/outside.txt',
        ],
        artifact_paths: [
          '.saivage-work/cards/code-parent-1/artifacts/artifact-note.txt',
          '.saivage/saivage.json',
        ],
        verification_commands: [
          {
            command: 'node scripts/verify-stage-v3-local-recreation.mjs',
            processId: 'verify-local-1',
            status: 'completed',
            exitCode: 0,
            timedOut: false,
          },
        ],
        tool_errors: ['assistant returned malformed final JSON; preserved tool evidence fallback'],
        parse_failure: { message: 'Unexpected token } in JSON at position 17' },
      },
      artifacts: [
        {
          sourceFile: join(sourceDir, 'artifact-note.txt'),
          type: 'report',
          description: 'Retained artifact copied into .saivage-work card storage.',
          retain: true,
        },
      ],
      attachments: [
        {
          sourceFile: join(sourceDir, 'attachment-output.txt'),
          mime: 'text/plain',
          title: 'Generated attachment preview',
          description: 'Attachment captured for card detail preview.',
        },
      ],
    },
    'code-parent-2': { card_id: 'code-parent-2', status: 'done', result: { summary: 'second leaf complete' } },
  },
  reviewer: [
    {
      assessment: {
        id: 'review-goal-1',
        goal_card_id: 'goal-parent-1',
        reviewer_session_id: 'rev-goal-1',
        result: 'pass',
        summary: 'First goal completed with preserved executor evidence.',
        achieved: ['Executed code-parent-1', 'Executed code-parent-2'],
        missing: [],
        evidence_card_ids: ['code-parent-1', 'code-parent-2'],
        created_at: now,
      },
    },
  ],
});
createFixture('goal-one-leaf', {
  name: 'goal-one-leaf',
  planner: [
    {
      status: 'done',
      created_cards: [
        {
          id: 'code-parent-3',
          type: 'code',
          title: 'Final leaf card',
          description: 'Execute for the follow-up top-level goal.',
          status: 'backlog',
          depends_on: [],
          priority: 1,
        },
      ],
      summary: 'Created one child card and declared done.',
    },
  ],
  executor: {
    'code-parent-3': { card_id: 'code-parent-3', status: 'done', result: { summary: 'third leaf complete' } },
  },
  reviewer: [
    {
      assessment: {
        id: 'review-goal-2',
        goal_card_id: 'goal-parent-2',
        reviewer_session_id: 'rev-goal-2',
        result: 'pass',
        summary: 'Second top-level goal completed.',
        achieved: ['Executed code-parent-3'],
        missing: [],
        evidence_card_ids: ['code-parent-3'],
        created_at: now,
      },
    },
  ],
});

const mapping = {
  project: 'project-parent',
  'goal-parent-1': 'goal-two-leaves',
  'goal-parent-2': 'goal-one-leaf',
};

const fakeAgent = new FakeAgentAdapter({ mapping, fixtureDir });
const runtime = new Runtime({
  projectRoot: isolatedRoot,
  fakeAgentConfig: { mapping, fixtureDir },
}, fakeAgent);

let app;
let port = 0;
const previousToken = process.env.SAIVAGE_API_TOKEN;
process.env.SAIVAGE_API_TOKEN = token;

try {
  await runtime.startup();
  await runtime.dispatchGoal('project');

  const cardsIndex = JSON.parse(readFileSync(join(isolatedRoot, '.saivage', 'cards', 'index.json'), 'utf-8'));
  const frameDir = join(isolatedRoot, '.saivage', 'runtime', 'planner-frames');
  const dispatchDir = join(isolatedRoot, '.saivage', 'runtime', 'planner-dispatches');
  const frames = readdirSync(frameDir).map((name) => ({ name, data: JSON.parse(readFileSync(join(frameDir, name), 'utf-8')) }));
  const dispatches = readdirSync(dispatchDir).map((name) => ({ name, data: JSON.parse(readFileSync(join(dispatchDir, name), 'utf-8')) }));
  const runtimeState = JSON.parse(readFileSync(join(isolatedRoot, '.saivage', 'runtime', 'state.json'), 'utf-8'));
  const eventsLog = readFileSync(join(isolatedRoot, '.saivage', 'runtime', 'events.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const codeParent1 = JSON.parse(readFileSync(join(isolatedRoot, '.saivage', 'cards', 'by-id', 'code-parent-1.json'), 'utf-8'));

  snapshotJson('cards-index.json', cardsIndex);
  snapshotJson('planner-frames.json', frames);
  snapshotJson('planner-dispatches.json', dispatches);
  snapshotJson('runtime-state.json', runtimeState);
  snapshotJson('runtime-events.json', eventsLog);
  snapshotJson('code-parent-1-card.json', codeParent1);

  app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  await app.register(authPlugin);
  registerCardRoutes(app, isolatedRoot);
  registerChatsFilesDebugRoutes(app, isolatedRoot);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = app.server.address().port;

  const headers = { authorization: `Bearer ${token}` };
  const fetchJson = async (path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body };
  };

  const cardDetail = await fetchJson('/api/cards/code-parent-1');
  const redactedSaivage = await fetchJson('/api/files/content?path=.saivage/saivage.json');
  const blockedAuthProfiles = await fetchJson('/api/files/content?path=.saivage/auth-profiles.json');
  const artifactPreviewPath = cardDetail.body?.body?.evidence?.generatedFiles?.[0]?.path ?? cardDetail.body?.evidence?.generatedFiles?.[0]?.path;
  const attachmentPreviewPath = cardDetail.body?.body?.evidence?.generatedFiles?.[1]?.path ?? cardDetail.body?.evidence?.generatedFiles?.[1]?.path;
  const artifactPreview = artifactPreviewPath ? await fetchJson(`/api/files/content?path=${encodeURIComponent(artifactPreviewPath)}`) : null;
  const attachmentPreview = attachmentPreviewPath ? await fetchJson(`/api/files/content?path=${encodeURIComponent(attachmentPreviewPath)}`) : null;
  const binaryPreview = await fetchJson('/api/files/content?path=source-artifacts/binary.bin');
  const debugState = await fetchJson('/api/debug/state');

  snapshotJson('api-card-detail.json', cardDetail);
  snapshotJson('api-redacted-saivage.json', redactedSaivage);
  snapshotJson('api-blocked-auth-profiles.json', blockedAuthProfiles);
  snapshotJson('api-artifact-preview.json', artifactPreview);
  snapshotJson('api-attachment-preview.json', attachmentPreview);
  snapshotJson('api-binary-preview.json', binaryPreview);
  snapshotJson('api-debug-state.json', debugState);

  const normalizedGeneratedFiles = cardDetail.body?.evidence?.generatedFiles ?? [];
  const projectLocalAudit = {
    isolatedRoot,
    requiredRoots: ['.saivage', '.saivage-work'],
    topLevelEntries: readdirSync(isolatedRoot).sort(),
    cardStoragePath: '.saivage-work/cards',
    plannerFramePath: '.saivage/runtime/planner-frames',
    plannerDispatchPath: '.saivage/runtime/planner-dispatches',
    normalizedEvidenceExcludedOutsidePaths: normalizedGeneratedFiles.every((entry) => !String(entry.path).includes('outside')),
    retainedFilesStayProjectLocal: normalizedGeneratedFiles
      .filter((entry) => entry.path.startsWith('.saivage') || entry.path.startsWith('.saivage-work'))
      .every((entry) => !entry.path.startsWith('/')),
  };
  snapshotJson('state-path-audit.json', projectLocalAudit);

  const summary = {
    isolatedRoot,
    plannerCounts: {
      project: fakeAgent.getPlannerCount('project'),
      goal1: fakeAgent.getPlannerCount('goal-parent-1'),
      goal2: fakeAgent.getPlannerCount('goal-parent-2'),
    },
    reviewerCounts: {
      project: fakeAgent.getReviewerCount('project'),
      goal1: fakeAgent.getReviewerCount('goal-parent-1'),
      goal2: fakeAgent.getReviewerCount('goal-parent-2'),
    },
    totalCards: Object.keys(cardsIndex.cards).length,
    topLevelGoalStatuses: ['goal-parent-1', 'goal-parent-2'].map((id) => ({ id, status: cardsIndex.cards[id]?.status ?? null })),
    dispatchTargets: dispatches.map((entry) => entry.data.target_card_id),
    artifacts: codeParent1.artifacts,
    attachments: codeParent1.attachments,
    generatedFiles: cardDetail.body?.evidence?.generatedFiles ?? [],
    verificationCommands: cardDetail.body?.evidence?.verificationCommands ?? [],
    parseFailure: cardDetail.body?.evidence?.parseFailure ?? null,
    toolErrors: cardDetail.body?.evidence?.toolErrors ?? [],
    apiChecks: {
      cardDetailStatus: cardDetail.status,
      redactedSaivageStatus: redactedSaivage.status,
      blockedAuthProfilesStatus: blockedAuthProfiles.status,
      artifactPreviewStatus: artifactPreview?.status ?? null,
      attachmentPreviewStatus: attachmentPreview?.status ?? null,
      binaryPreviewStatus: binaryPreview.status,
    },
  };
  writeJson(join(reportDir, 't2-local-recreation-summary.json'), summary);

  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (app) {
    try { await app.close(); } catch {}
  }
  try { await runtime.shutdown(); } catch {}
  try { releaseLock(isolatedRoot); } catch {}
  if (previousToken === undefined) {
    delete process.env.SAIVAGE_API_TOKEN;
  } else {
    process.env.SAIVAGE_API_TOKEN = previousToken;
  }
}
