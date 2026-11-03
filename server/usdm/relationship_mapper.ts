import type { MapperOutput } from './entity_mapper.ts';
import type { LoadedRelease, UsdmModel } from './usdm_version.ts';

// Pipeline stage 3b: relationship mapping. A relationship is only created when (a) internal data supports it and
// (b) its mapping rule is active and approved for use. Each link is checked for target existence, class compatibility
// against the USDM model, direction (the property exists on the source class), duplicates and required cardinality.

export interface RelationshipRecord {
  key: string;
  fromId: string;
  fromClass: string;
  property: string;
  toId: string;
  toClass: string | null;
  status: 'created' | 'blocked' | 'invalid' | 'duplicate';
  message?: string;
  elementId?: string;
}

export interface RelationshipIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  elementId?: string;
  usdmId?: string;
  usdmClass?: string;
  property?: string;
}

interface Registered {
  cls: string;
  obj: Record<string, any>;
  elementId?: string;
}

export function isSubclass(model: UsdmModel | null, cls: string, target: string): boolean {
  if (cls === target) return true;
  if (!model) return false;
  const seen = new Set<string>();
  const stack = [cls];
  while (stack.length) {
    const c = stack.pop()!;
    if (c === target) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...(model.classes[c]?.superClasses ?? []));
  }
  return false;
}

export class RelationshipMapper {
  readonly records: RelationshipRecord[] = [];
  readonly issues: RelationshipIssue[] = [];
  private readonly objects = new Map<string, Registered>();
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly release: LoadedRelease,
    private readonly mapped: MapperOutput,
  ) {}

  register(id: string, cls: string, obj: Record<string, any>, elementId?: string) {
    if (this.objects.has(id)) this.issues.push({ level: 'error', code: 'duplicate-id', message: `Two USDM objects were assigned id '${id}'`, usdmId: id, usdmClass: cls, elementId });
    this.objects.set(id, { cls, obj, elementId });
    return obj;
  }

  has(id: string) {
    return this.objects.has(id);
  }

  classOf(id: string) {
    return this.objects.get(id)?.cls ?? null;
  }

  /** Whether the relationship rule is usable; records a blocked relationship otherwise. */
  allowed(key: string, context?: { fromId: string; fromClass: string; property: string; elementId?: string }) {
    if (this.mapped.relationships.has(key)) return true;
    const rule = this.mapped.blockedRelationships.get(key);
    if (context)
      this.records.push({
        key,
        ...context,
        toId: '',
        toClass: null,
        status: 'blocked',
        message: rule ? `Relationship rule '${key}' is ${rule.active ? rule.status : 'inactive'}` : `No active mapping rule for relationship '${key}'`,
      });
    return false;
  }

  /**
   * Queues a reference from obj.property to target id(s). Applied after all objects are registered so targets can be
   * checked. Single-valued properties take the first valid target.
   */
  link(key: string, fromId: string, property: string, targets: string | string[], opts: { many?: boolean; elementId?: string } = {}) {
    const from = this.objects.get(fromId);
    if (!from) return;
    if (!this.allowed(key, { fromId, fromClass: from.cls, property, elementId: opts.elementId })) return;
    const list = Array.isArray(targets) ? targets : [targets];
    this.queue.push(() => {
      const attr = this.release.model?.classes[from.cls]?.attributes[property];
      const seen = new Set<string>();
      const valid: string[] = [];
      for (const toId of list) {
        const rec: RelationshipRecord = { key, fromId, fromClass: from.cls, property, toId, toClass: this.classOf(toId), status: 'created', elementId: opts.elementId ?? from.elementId };
        if (!attr || attr.relationship !== 'Ref') {
          rec.status = 'invalid';
          rec.message = `${from.cls}.${property} is not a reference property in USDM ${this.release.version} (wrong direction or unknown property)`;
        } else if (!this.objects.has(toId)) {
          rec.status = 'invalid';
          rec.message = `Target '${toId}' does not exist in this mapping (missing, excluded pending review, or deleted)`;
        } else if (!attr.types.some((t) => isSubclass(this.release.model, rec.toClass!, t))) {
          rec.status = 'invalid';
          rec.message = `${rec.toClass} is not compatible with ${from.cls}.${property} (expects ${attr.types.join(' | ')})`;
        } else if (seen.has(toId)) {
          rec.status = 'duplicate';
          rec.message = 'Duplicate relationship ignored';
        }
        this.records.push(rec);
        if (rec.status === 'invalid')
          this.issues.push({ level: 'error', code: 'invalid-relationship', message: rec.message!, elementId: rec.elementId, usdmId: fromId, usdmClass: from.cls, property });
        if (rec.status === 'duplicate') this.issues.push({ level: 'warning', code: 'duplicate-relationship', message: `${from.cls}.${property} → ${toId} listed more than once`, elementId: rec.elementId, usdmId: fromId, property });
        if (rec.status !== 'created') continue;
        seen.add(toId);
        valid.push(toId);
      }
      if (!valid.length) return;
      if (opts.many) from.obj[property] = valid;
      else from.obj[property] = valid[0];
    });
  }

  /** Records a containment relationship (USDM 'Value' attribute) created by the assembler. */
  contained(key: string, fromId: string, property: string, toId: string, elementId?: string) {
    this.records.push({ key, fromId, fromClass: this.classOf(fromId) ?? '', property, toId, toClass: this.classOf(toId), status: 'created', elementId });
  }

  /** Records a relationship that internal data asked for but that could not be created. */
  rejected(key: string, fromId: string, property: string, toId: string, message: string, level: 'error' | 'warning' | 'info', elementId?: string) {
    this.records.push({ key, fromId, fromClass: this.classOf(fromId) ?? '', property, toId, toClass: this.classOf(toId), status: 'invalid', message, elementId });
    this.issues.push({ level, code: 'relationship-not-created', message, elementId, usdmId: fromId, usdmClass: this.classOf(fromId) ?? undefined, property });
  }

  /** Links consecutive objects with previousId/nextId. */
  chain(key: string, ids: string[]) {
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) this.link(key, ids[i], 'previousId', ids[i - 1]);
      if (i < ids.length - 1) this.link(key, ids[i], 'nextId', ids[i + 1]);
    }
  }

  apply() {
    for (const fn of this.queue.splice(0)) fn();
  }

  summary() {
    const by: Record<string, { created: number; blocked: number; invalid: number; duplicate: number }> = {};
    for (const r of this.records) {
      const s = (by[r.key] ??= { created: 0, blocked: 0, invalid: 0, duplicate: 0 });
      s[r.status]++;
    }
    return by;
  }

  registered() {
    return this.objects;
  }
}
