import { getHumanReadableAttributeLabel, staticID } from "../../utils.mjs";
import FiltersField from "../fields/filters-field.mjs";

const { DocumentIdField, DocumentUUIDField, SchemaField, StringField } = foundry.data.fields;

/**
 * Abstract base class to add some shared functionality to all of the system's custom active effect types.
 * @abstract
 */
export default class ActiveEffectDataModel extends foundry.data.ActiveEffectTypeDataModel {
  /* -------------------------------------------- */
  /*  Model Configuration                         */
  /* -------------------------------------------- */

  /** @inheritDoc */
  static defineSchema() {
    const schema = {
      ...super.defineSchema(),
      origin: new SchemaField({
        activity: new StringField({ required: false }),
        actor: new DocumentUUIDField({ relative: true, required: false, type: "Actor" }),
        behavior: new DocumentUUIDField({ required: false, type: "RegionBehavior" }),
        effect: new DocumentUUIDField({ relative: true, required: false, type: "ActiveEffect" }),
        item: new DocumentUUIDField({ relative: true, required: false, type: "Item" }),
        message: new DocumentUUIDField({ required: false, type: "ChatMessage" }),
        profile: new DocumentIdField({ readonly: false, required: false })
      })
    };
    schema.changes.element.extendFields({
      _id: new DocumentIdField({ initial: () => foundry.utils.randomID() }),
      conditions: new FiltersField(),
      replacement: new StringField({
        required: true,
        blank: true,
        choices: {
          origin: "DND5E.EFFECT.Replacement.Origin",
          target: "DND5E.EFFECT.Replacement.Target"
        }
      })
    });
    return schema;
  }

  /* -------------------------------------------- */
  /*  Data Preparation                            */
  /* -------------------------------------------- */

  /** @inheritDoc */
  prepareBaseData() {
    this.#conditionSuppressed = null;
    super.prepareBaseData();
    if ( this.isOnActivity ) this.parent.transfer = this.parent.disabled = false;
  }

  /* -------------------------------------------- */
  /*  Properties                                  */
  /* -------------------------------------------- */

  /**
   * Actor within which this effect is embedded.
   * @type {Actor5e|void}
   */
  get actor() {
    return this.item ? this.item.actor : this.parent.parent instanceof Actor ? this.parent.parent : undefined;
  }

  /* -------------------------------------------- */

  /**
   * Document type to which this active effect should apply its changes.
   * @type {string}
   */
  get applicableType() {
    return "Actor";
  }

  /* -------------------------------------------- */

  /**
   * Cached evaluation of effect's condition during the initial application phase.
   * @type {boolean|null}
   */
  #conditionSuppressed = null;

  /* -------------------------------------------- */

  /**
   * Should this status effect be hidden from the current user? Concealed effects are still applied, but won't be
   * visible on the actor's token or in the effects list on sheets.
   * @type {boolean}
   */
  get isConcealed() {
    return false;
  }

  /* -------------------------------------------- */

  /**
   * Is this effect selected by any activity on its parent item?
   * @type {boolean}
   */
  get isOnActivity() {
    return !!this.item
      && (this.item.system.activities?.contents ?? []).some(a => a.effects?.some(e => e._id === this.parent._id));
  }

  /* -------------------------------------------- */

  /**
   * Is there some system logic that makes this Active Effect ineligible for application?
   * @type {boolean|void}  Returns a boolean to indicate explicit suppression status, otherwise defers to the base
   *                       ActiveEffect suppression logic.
   */
  get isSuppressed() {
    return this.#conditionSuppressed || undefined;
  }

  /* -------------------------------------------- */

  /**
   * Item within which this effect is contained, if any.
   * @type {Item5e|void}
   */
  get item() {
    return this.parent.parent instanceof Item ? this.parent.parent : undefined;
  }

  /* -------------------------------------------- */
  /*  Event Listeners and Handlers                */
  /* -------------------------------------------- */

  /**
   * Add modifications to the core ActiveEffect config.
   * @param {ActiveEffectConfig} app            The ActiveEffect config.
   * @param {HTMLElement} html                  The ActiveEffect config element.
   * @param {ApplicationRenderContext} context  The app's rendering context.
   */
  onRenderActiveEffectConfig(app, html, context) {}

  /* -------------------------------------------- */
  /*  Helpers                                     */
  /* -------------------------------------------- */

  /**
   * Conditions applied separately by this effect, including riders of its statuses.
   * @type {Set<string>}
   */
  get riderStatuses() {
    const riders = new Set(this.rider?.statuses ?? []);
    for ( const status of this.parent.statuses ) {
      for ( const id of CONFIG.statusEffects[status]?.riders ?? [] ) riders.add(id);
    }
    return riders;
  }

  /* -------------------------------------------- */

  /**
   * Handle creating rider documents when this active effect is created.
   * @param {DatabaseOperation} [options={}]       Options passed to the create or update operation.
   * @param {Map<Actor, Map<string, object>>} [pending]  Conditions already queued by the same operation.
   * @returns {Promise<DatabaseWriteOperation[]>}  Batch entries suitable for `foundry.documents.modifyBatch`.
   */
  async collectRiders(options={}, pending=new Map()) {
    if ( !(this.parent.target instanceof Actor) || !this.parent.active ) return [];

    const riders = this.riderStatuses;
    if ( !riders.size ) return [];

    const actor = this.parent.actor;
    const conditions = pending.get(actor) ?? new Map();
    pending.set(actor, conditions);
    const data = [];
    const updates = [];
    const applied = new Set(this.parent.getFlag("dnd5e", "appliedRiderConditions") ?? []);
    let appliedConditions = false;
    for ( const id of riders ) {
      const maxLevel = CONFIG.DND5E.conditionTypes[id]?.levels;
      const leveled = Number.isFinite(maxLevel);
      let condition = conditions.get(id);
      if ( leveled && (applied.has(id) || condition?.sources.has(this.parent.uuid)) ) continue;
      if ( condition && !leveled ) continue;

      const conditionId = staticID(`dnd5e${id}`);
      const existing = actor.effects.get(conditionId);
      if ( existing && !leveled ) continue;
      const create = !existing && !condition;
      if ( !condition ) {
        condition = { level: existing?.system.level ?? 1, originalLevel: existing?.system.level, sources: new Set() };
        conditions.set(id, condition);
        if ( create ) {
          const effect = await ActiveEffect.implementation.fromStatusEffect(id);
          const effectData = effect.toObject();
          if ( leveled ) effectData.system.level = 1;
          condition.data = effectData;
          data.push(effectData);
        }
      }
      if ( !leveled ) continue;

      // Each source grants a level of each condition once, even if it is subsequently edited or re-enabled.
      condition.sources.add(this.parent.uuid);
      applied.add(id);
      appliedConditions = true;
      const level = Math.clamp(condition.level + (create ? 0 : 1), 1, maxLevel);
      if ( level === condition.level ) continue;
      condition.level = level;
      if ( condition.data ) condition.data.system.level = level;
      else if ( condition.update ) condition.update["system.level"] = level;
      else {
        condition.update = { _id: conditionId, "system.level": level };
        updates.push({
          action: "update", documentName: "ActiveEffect", updates: [condition.update], parent: actor,
          dnd5e: { originalLevel: condition.originalLevel }
        });
      }
    }

    const operations = [];
    if ( data.length ) operations.push({
      action: "create", documentName: "ActiveEffect", data, parent: actor, keepId: true
    });
    operations.push(...updates);
    if ( appliedConditions ) operations.push({
      action: "update", documentName: "ActiveEffect", parent: this.parent.parent,
      updates: [{ _id: this.parent.id, "flags.dnd5e.appliedRiderConditions": Array.from(applied) }]
    });
    return operations;
  }

  /* -------------------------------------------- */

  /**
   * Evaluate the effect's conditions and store the result.
   * @param {RollData} [baseData]
   */
  evaluateCondition(baseData) {
    if ( this.#conditionSuppressed !== null ) return;
    baseData ??= this.parent.target?.getRollData() ?? {};
    this.#conditionSuppressed = this.conditions?.check(this.parent.getReplacementData(baseData)) === false;
  }

  /* -------------------------------------------- */

  /**
   * Prepare the context for individual changes to display on actor, item, or active effect sheets.
   * @param {object} change     Change to prepare.
   * @param {object} [options]  Options forwarded to getHumanReadableAttributeLabel.
   * @returns {object}          An object of chat data to render.
   */
  async getSheetChangeContext(change, options) {
    options ??= { actor: this.actor, prefixItemName: false };
    if ( CONFIG.ActiveEffect.changeTypes[change.type]?.keyOptions ) {
      const name = CONFIG.ActiveEffect.changeTypes[change.type].keyOptions.find(k => k.value === change.key)?.label;
      return { name: name ? _loc(name) : change.key };
    }
    return { name: getHumanReadableAttributeLabel(change.key, options) };
  }

  /* -------------------------------------------- */

  /**
   * Prepare type-specific data for the Active Effect config sheet.
   * @param {ApplicationRenderContext} context  Sheet context data.
   * @returns {Promise<void>}
   */
  async getSheetData(context) {}
}
