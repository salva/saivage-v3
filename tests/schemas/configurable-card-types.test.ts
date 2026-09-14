import { describe, expect, it } from '@jest/globals';
import { DEFAULT_SAIVAGE_CONFIG, resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { cardTypeNameSchema } from '../../src/schemas/index.js';
import { effectiveSaivageConfigSchema, outboundEffectiveSaivageConfigSchema, saivageConfigSchema, systemTemplateNameSchema } from '../../src/schemas/saivage-config.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';

function projectOnly() {
  const config:SaivageConfig=effectiveSaivageConfigSchema.parse(structuredClone(DEFAULT_SAIVAGE_CONFIG));
  const project=structuredClone(config.card_types.project!);
  project.permitted_child_types=[];
  config.card_types={project};
  return config;
}

describe('configuration-owned card types',()=>{
  it('rejects the deleted card_type_set selector while effective contracts require a complete map',()=>{
    const globals=structuredClone(DEFAULT_SAIVAGE_CONFIG) as Record<string,unknown>;
    delete globals.card_types;
    expect(saivageConfigSchema.parse(globals)).not.toHaveProperty('card_types');
    expect(saivageConfigSchema.safeParse({...globals,card_type_set:'standard'}).success).toBe(false);
    expect(saivageConfigSchema.safeParse({...globals,card_type_set:'standard',card_types:structuredClone(DEFAULT_SAIVAGE_CONFIG.card_types)}).success).toBe(false);
    expect(systemTemplateNameSchema.safeParse('Standard').success).toBe(false);
    expect(effectiveSaivageConfigSchema.safeParse({...globals,card_type_set:'standard'}).success).toBe(false);
    expect(outboundEffectiveSaivageConfigSchema.safeParse({...globals,card_type_set:'standard'}).success).toBe(false);
  });

  it('parses the complete specialized identifier inventory while node keys remain compiler-strict',()=>{
    const typedCardTypes=resolveSystemTemplate('classic-typed').config.card_types;
    expect(saivageConfigSchema.parse({ ...structuredClone(DEFAULT_SAIVAGE_CONFIG), card_types: structuredClone(typedCardTypes) }).card_types).toEqual(typedCardTypes);
    for(const id of ['specialized','project','goal','architecture','code','test','doc','data','research','ops','add-coverage','component-review','system-review'])expect(systemTemplateNameSchema.safeParse(id).success).toBe(true);
    for(const id of ['complete_direct','revision_required','ready_for_component_review'])expect(/^[a-z][a-z0-9_-]{0,63}$/u.test(id)).toBe(true);
  });

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

  it('requires strict designated-recipient and pending-notifications declarations',()=>{
    const missing=structuredClone(projectOnly()) as unknown as {card_types:{project:{workflow:Record<string,unknown>}}};
    delete missing.card_types.project.workflow.notification_recipient;
    expect(saivageConfigSchema.safeParse(missing).success).toBe(false);
    const malformed=structuredClone(projectOnly()) as unknown as {card_types:{project:{workflow:{nodes:{review:{edges:{approved:Record<string,unknown>}}}}}}};
    malformed.card_types.project.workflow.nodes.review.edges.approved.pending_notifications={node:'handle-notifications',prompt:'review-to-notifications',legacy_recipient:'planner'};
    expect(saivageConfigSchema.safeParse(malformed).success).toBe(false);
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
