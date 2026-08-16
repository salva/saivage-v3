import { describe, expect, it } from '@jest/globals';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/agents/default-workflow-config.js';
import { cardTypeNameSchema } from '../../src/schemas/index.js';
import { effectiveSaivageConfigSchema, outboundEffectiveSaivageConfigSchema, saivageConfigSchema } from '../../src/schemas/saivage-config.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';

function projectOnly() {
  const config:SaivageConfig=effectiveSaivageConfigSchema.parse(structuredClone(DEFAULT_SAIVAGE_CONFIG));
  const project=structuredClone(config.card_types.project!);
  project.permitted_child_types=[];
  config.card_types={project};
  return config;
}

describe('configuration-owned card types',()=>{
  it('accepts project-only and arbitrary valid configured identifiers in declaration order',()=>{
    const only=projectOnly();
    expect(saivageConfigSchema.parse(only).card_types).toEqual(only.card_types);
    const custom=projectOnly();
    custom.card_types.project!.permitted_child_types=['initiative'];
    custom.card_types.initiative=structuredClone(DEFAULT_SAIVAGE_CONFIG.card_types.goal!);
    custom.card_types.initiative.permitted_child_types=[];
    expect(Object.keys(effectiveSaivageConfigSchema.parse(custom).card_types)).toEqual(['project','initiative']);
    expect(Object.keys(outboundEffectiveSaivageConfigSchema.parse(custom).card_types)).toEqual(['project','initiative']);
  });

  it('rejects missing project, invalid names, duplicate/project children, and missing references at the referring path',()=>{
    const missing=projectOnly();delete missing.card_types.project;
    expect(saivageConfigSchema.safeParse(missing).error?.issues).toEqual(expect.arrayContaining([expect.objectContaining({path:['card_types','project']})]));
    expect(cardTypeNameSchema.safeParse('Not_valid').success).toBe(false);
    const invalid=projectOnly();
    invalid.card_types.project!.permitted_child_types=['project','missing','missing'];
    const issues=saivageConfigSchema.safeParse(invalid).error?.issues??[];
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({path:['card_types','project','permitted_child_types',0],message:expect.stringContaining("reserved 'project'")}),
      expect.objectContaining({path:['card_types','project','permitted_child_types',1],message:expect.stringContaining("has no card_types entry")}),
      expect.objectContaining({path:['card_types','project','permitted_child_types',2],message:expect.stringContaining('duplicate')}),
    ]));
    const badKey={...projectOnly(),card_types:{'Bad Key':structuredClone(DEFAULT_SAIVAGE_CONFIG.card_types.project!)}};
    expect(saivageConfigSchema.safeParse(badKey).success).toBe(false);
  });
});
